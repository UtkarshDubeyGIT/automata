const VIKUNJA_ORIGIN = "https://vikunja.doubtbuddy.com";
const VIKUNJA_API = `${VIKUNJA_ORIGIN}/api/v1`;

export type VikunjaErrorKind = "credentials" | "permission" | "connection" | "provider";

export class VikunjaError extends Error {
  readonly kind: VikunjaErrorKind;
  readonly status?: number;

  constructor(
    message: string,
    kind: VikunjaErrorKind,
    status?: number,
  ) {
    super(message);
    this.name = "VikunjaError";
    this.kind = kind;
    this.status = status;
  }
}

export interface VikunjaProject {
  id: number;
  title: string;
  description?: string;
  is_archived?: boolean;
  max_permission?: number;
}

export interface VikunjaTask {
  id: number;
  title: string;
  description?: string;
  identifier?: string;
  project_id?: number;
}

export interface VikunjaTaskInput {
  title: string;
  description?: string;
}

type Fetcher = typeof fetch;

function providerMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const value = (body as { message?: unknown }).message;
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function classify(status: number): VikunjaErrorKind {
  if (status === 401) return "credentials";
  if (status === 403) return "permission";
  return "provider";
}

export function createVikunjaClient(token: string, fetcher: Fetcher = fetch) {
  const apiToken = token.trim();
  if (!apiToken) throw new VikunjaError("A Vikunja API token is required.", "credentials");

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${VIKUNJA_API}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiToken}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(15_000),
      });
    } catch {
      throw new VikunjaError("Vikunja could not be reached. Try again shortly.", "connection");
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const kind = classify(response.status);
      const fallback = kind === "credentials"
        ? "The Vikunja API token is invalid or expired."
        : kind === "permission"
          ? "The Vikunja API token does not have the required permission."
          : `Vikunja returned HTTP ${response.status}.`;
      const message = providerMessage(body, fallback).split(apiToken).join("[redacted]");
      throw new VikunjaError(message, kind, response.status);
    }
    return body as T;
  }

  async function listProjects(): Promise<VikunjaProject[]> {
    const projects = await request<VikunjaProject[]>("/projects?expand=permissions&per_page=100");
    return projects.filter(
      (project) => !project.is_archived && (project.max_permission ?? 0) >= 1,
    );
  }

  return {
    verify: listProjects,
    listProjects,
    createTask(projectId: number, task: VikunjaTaskInput): Promise<VikunjaTask> {
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        throw new VikunjaError("A valid Vikunja project is required.", "provider");
      }
      const title = task.title.trim();
      if (!title) throw new VikunjaError("A task title is required.", "provider");
      return request<VikunjaTask>(`/projects/${projectId}/tasks`, {
        method: "PUT",
        body: JSON.stringify({
          title,
          ...(task.description?.trim() ? { description: task.description.trim() } : {}),
        }),
      });
    },
    getTask(taskId: number): Promise<VikunjaTask> {
      if (!Number.isSafeInteger(taskId) || taskId <= 0) {
        throw new VikunjaError("A valid Vikunja task is required.", "provider");
      }
      return request<VikunjaTask>(`/tasks/${taskId}`);
    },
    taskUrl(taskId: number): string {
      return `${VIKUNJA_ORIGIN}/tasks/${taskId}`;
    },
  };
}

export const VIKUNJA_PROVIDER = "vikunja";
export const VIKUNJA_INSTANCE_URL = VIKUNJA_ORIGIN;
