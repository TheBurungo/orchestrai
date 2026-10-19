import type {
  AdapterInfo,
  AttentionAction,
  AttentionItem,
  AutonomyLevel,
  Overview,
  Project,
  ProjectDetail,
  ProjectLimits,
  ProjectPolicy,
  VerificationRule,
} from "../../shared/types.js";

export type AdapterListing = AdapterInfo & { supportedRules: VerificationRule["type"][] };

export interface NewProjectInput {
  name: string;
  goal: string;
  constraints: string;
  context: string;
  adapter: string;
  adapterConfig: Record<string, string>;
  autonomy: AutonomyLevel;
  policy: ProjectPolicy;
  limits: ProjectLimits;
  criteria: { description: string; rule: VerificationRule }[];
  start: boolean;
}

export class ApiError extends Error {}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  overview: () => request<Overview>("GET", "/overview"),
  adapters: () => request<AdapterListing[]>("GET", "/adapters"),
  project: (id: string) => request<ProjectDetail>("GET", `/projects/${encodeURIComponent(id)}`),
  createProject: (input: NewProjectInput) => request<Project>("POST", "/projects", input),
  command: (id: string, command: "start" | "pause" | "resume" | "stop") =>
    request<Project>("POST", `/projects/${encodeURIComponent(id)}/${command}`, {}),
  updateSettings: (
    id: string,
    patch: Partial<{ autonomy: AutonomyLevel; policy: ProjectPolicy; limits: ProjectLimits; adapterConfig: Record<string, string>; context: string }>,
  ) => request<Project>("PATCH", `/projects/${encodeURIComponent(id)}/settings`, patch),
  addTask: (id: string, input: { title: string; description: string; actionKind: string }) =>
    request("POST", `/projects/${encodeURIComponent(id)}/tasks`, input),
  addGuidance: (id: string, text: string) => request("POST", `/projects/${encodeURIComponent(id)}/guidance`, { text }),
  resolve: (itemId: string, action: AttentionAction, note: string | null) =>
    request<AttentionItem>("POST", `/attention/${encodeURIComponent(itemId)}/resolve`, { action, note }),
  seedDemo: () => request("POST", "/demo/seed", {}),
};
