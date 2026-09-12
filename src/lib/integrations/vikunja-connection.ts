import { deleteCredential, readCredential, saveCredential } from "@/lib/credentials";
import {
  createVikunjaClient,
  normalizeVikunjaInstanceUrl,
  VIKUNJA_PROVIDER,
  type VikunjaProject,
} from "./vikunja";
import { assertPublicUrl } from "@/lib/net/public-url";

interface VikunjaCredential {
  token: string;
  instanceUrl: string;
  lastTestedAt: string;
  lastTestStatus: "connected";
}

export interface VikunjaConnectionStatus {
  connected: boolean;
  instanceUrl: string;
  lastTestedAt: string | null;
  lastTestStatus: "connected" | null;
}

export async function connectVikunja(
  workspaceId: string,
  instanceUrl: string,
  token: string,
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>,
) {
  const normalized = normalizeVikunjaInstanceUrl(instanceUrl);
  const publicUrl = await assertPublicUrl(normalized);
  if (!publicUrl) throw new Error("The Vikunja app URL must resolve to a public server.");
  const client = createVikunjaClient(normalized, token, fetcher);
  const projects = await client.verify();
  const lastTestedAt = new Date().toISOString();
  await saveCredential(workspaceId, VIKUNJA_PROVIDER, {
    token: token.trim(),
    instanceUrl: normalized,
    lastTestedAt,
    lastTestStatus: "connected",
  } satisfies VikunjaCredential);
  return { connected: true as const, instanceUrl: normalized, projectCount: projects.length, lastTestedAt };
}

export async function vikunjaStatus(workspaceId: string): Promise<VikunjaConnectionStatus> {
  const credential = await readCredential<VikunjaCredential>(workspaceId, VIKUNJA_PROVIDER);
  return credential?.token
    ? {
        connected: true,
        instanceUrl: credential.instanceUrl,
        lastTestedAt: credential.lastTestedAt ?? null,
        lastTestStatus: credential.lastTestStatus ?? null,
      }
    : {
        connected: false,
        instanceUrl: "",
        lastTestedAt: null,
        lastTestStatus: null,
      };
}

export async function disconnectVikunja(workspaceId: string): Promise<void> {
  await deleteCredential(workspaceId, VIKUNJA_PROVIDER);
}

async function credentialFor(workspaceId: string): Promise<VikunjaCredential> {
  const credential = await readCredential<VikunjaCredential>(workspaceId, VIKUNJA_PROVIDER);
  if (!credential?.token) throw new Error("Connect Vikunja before running this action.");
  return credential;
}

export async function listVikunjaProjects(workspaceId: string): Promise<VikunjaProject[]> {
  const credential = await credentialFor(workspaceId);
  return createVikunjaClient(credential.instanceUrl, credential.token).listProjects();
}

export async function vikunjaClientFor(workspaceId: string) {
  const credential = await credentialFor(workspaceId);
  return createVikunjaClient(credential.instanceUrl, credential.token);
}
