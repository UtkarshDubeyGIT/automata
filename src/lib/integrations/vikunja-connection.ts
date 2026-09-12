import { deleteCredential, readCredential, saveCredential } from "@/lib/credentials";
import {
  createVikunjaClient,
  VIKUNJA_INSTANCE_URL,
  VIKUNJA_PROVIDER,
  type VikunjaProject,
} from "./vikunja";

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
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const client = createVikunjaClient(token, fetcher);
  const projects = await client.verify();
  const lastTestedAt = new Date().toISOString();
  await saveCredential(workspaceId, VIKUNJA_PROVIDER, {
    token: token.trim(),
    instanceUrl: VIKUNJA_INSTANCE_URL,
    lastTestedAt,
    lastTestStatus: "connected",
  } satisfies VikunjaCredential);
  return { connected: true as const, projectCount: projects.length, lastTestedAt };
}

export async function vikunjaStatus(workspaceId: string): Promise<VikunjaConnectionStatus> {
  const credential = await readCredential<VikunjaCredential>(workspaceId, VIKUNJA_PROVIDER);
  return credential?.token
    ? {
        connected: true,
        instanceUrl: VIKUNJA_INSTANCE_URL,
        lastTestedAt: credential.lastTestedAt ?? null,
        lastTestStatus: credential.lastTestStatus ?? null,
      }
    : {
        connected: false,
        instanceUrl: VIKUNJA_INSTANCE_URL,
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
  return createVikunjaClient(credential.token).listProjects();
}

export async function vikunjaClientFor(workspaceId: string) {
  const credential = await credentialFor(workspaceId);
  return createVikunjaClient(credential.token);
}
