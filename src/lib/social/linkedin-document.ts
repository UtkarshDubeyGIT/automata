import { env } from "@/lib/env";
import { linkedinProxy } from "./linkedin-proxy";

/**
 * LinkedIn carousels, posted directly against LinkedIn's REST API.
 *
 * Composio's pinned LinkedIn toolkit exposes no document upload, while its
 * latest media tools use connector-managed file objects and do not cover every
 * author/media combination. The direct API keeps PDF carousels consistent for
 * both members and organization pages.
 *
 * What it still borrows from Composio is the credential: the OAuth connection
 * the user already granted, read back off the connected account. Nothing here
 * asks the user to authorize anything new — the token already carries
 * `w_member_social`, which is the scope document posts require.
 *
 * The flow is three calls, and it has to be three:
 *   1. initializeUpload — LinkedIn hands back a single-use upload URL and the
 *      document URN it will live at.
 *   2. PUT the PDF bytes to that URL. Not multipart, not JSON — raw body.
 *   3. Create the post referencing the URN.
 */

const REST = "https://api.linkedin.com/rest";

export class LinkedInDocumentError extends Error {}

function proxyHeaders() {
  return [
    { name: "X-Restli-Protocol-Version", value: "2.0.0", type: "header" as const },
    { name: "LinkedIn-Version", value: env.linkedinApiVersion, type: "header" as const },
    { name: "Content-Type", value: "application/json", type: "header" as const },
  ];
}

/**
 * The user's active LinkedIn connection id. Composio keeps the underlying
 * credential masked and injects it into every proxy request server-side.
 */
export { linkedinConnectedAccountId } from "./linkedin-proxy";

interface InitResponse {
  value?: {
    uploadUrl?: string;
    document?: string;
  };
}

/**
 * Publish slides, already rendered to PDF, as a LinkedIn document post.
 *
 * `author` is the URN the post is attributed to — person or organization. The
 * caller resolves it, because that decision (post as me vs as the company
 * page) belongs with the rest of the posting options.
 */
export async function publishCarousel(input: {
  connectedAccountId: string;
  author: string;
  commentary: string;
  pdf: Buffer;
  /** Shown as the document's name in feed. Keep it short and human. */
  title: string;
}): Promise<{ id: string }> {
  const { connectedAccountId, author, commentary, pdf, title } = input;

  // 1. Reserve an upload slot.
  const initRes = await linkedinProxy<InitResponse>({
    connectedAccountId,
    endpoint: `${REST}/documents?action=initializeUpload`,
    method: "POST",
    parameters: proxyHeaders(),
    body: { initializeUploadRequest: { owner: author } },
  });
  if (initRes.status < 200 || initRes.status >= 300) {
    throw new LinkedInDocumentError(
      `initializeUpload failed (${initRes.status})`,
    );
  }
  const init = initRes.data ?? {};
  const uploadUrl = init.value?.uploadUrl;
  const documentUrn = init.value?.document;
  if (!uploadUrl || !documentUrn) {
    throw new LinkedInDocumentError("initializeUpload returned no upload URL");
  }

  // 2. Ship the bytes through the same credential-injecting proxy.
  const putRes = await linkedinProxy({
    connectedAccountId,
    endpoint: uploadUrl,
    method: "PUT",
    binaryBody: { base64: pdf.toString("base64"), content_type: "application/pdf" },
  });
  if (putRes.status < 200 || putRes.status >= 300) {
    throw new LinkedInDocumentError(
      `Document upload failed (${putRes.status})`,
    );
  }

  // 3. The post itself. `media.id` is what makes this a carousel rather than
  //    a text post that happens to have a file near it.
  const postRes = await linkedinProxy({
    connectedAccountId,
    endpoint: `${REST}/posts`,
    method: "POST",
    parameters: proxyHeaders(),
    body: {
      author,
      commentary,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: { media: { id: documentUrn, title } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    },
  });
  if (postRes.status < 200 || postRes.status >= 300) {
    throw new LinkedInDocumentError(
      `Carousel post failed (${postRes.status})`,
    );
  }

  // The post URN comes back in a header, not the body — the body is empty.
  const id = postRes.headers?.["x-restli-id"] ?? postRes.headers?.["x-linkedin-id"] ?? "";
  return { id };
}
