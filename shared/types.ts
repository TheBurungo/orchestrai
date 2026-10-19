// Domain types shared by the server and the web UI.

export const PROJECT_STATES = [
  "ready",
  "working",
  "awaiting_approval",
  "blocked",
  "paused",
  "completed",
  "stopped",
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const AUTONOMY_LEVELS = ["manual", "supervised", "autonomous"] as const;
/**
 * manual      – every dispatch requires explicit approval.
 * supervised  – routine actions run automatically; gated actions need approval;
 *               a review checkpoint is raised every `policy.checkpointEvery` dispatches.
 * autonomous  – routine actions run automatically; gated actions still need approval.
 */
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Ordered from least to most consequential. */
export const ACTION_KINDS = [
  "read",
  "run_tests",
  "write_code",
  "open_pull_request",
  "deploy_staging",
  "external_communication",
  "spend",
  "merge",
  "deploy_production",
  "destructive",
  "other",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Actions that always require human approval, regardless of project policy or autonomy. */
export const ALWAYS_GATED_ACTIONS: readonly ActionKind[] = ["deploy_production", "destructive", "other"];

export interface ProjectPolicy {
  /** Additional action kinds that require approval for this project. */
  requireApproval: ActionKind[];
  /** Action kinds that are never allowed for this project. */
  deny: ActionKind[];
  /** In supervised mode, ask for a review after this many dispatches (0 disables). */
  checkpointEvery: number;
}

export interface ProjectLimits {
  /** Total spend allowed for the project, in US cents. */
  budgetCents: number;
  /** Maximum number of dispatches (agent turns) for the project. */
  maxSteps: number;
  /** Maximum attempts for any single task before escalating. */
  maxAttemptsPerTask: number;
  /** Consecutive dispatches without measurable progress before the project is marked stalled. */
  stallLimit: number;
}

export type VerificationRule =
  | { type: "artifact_exists"; artifact: string }
  | { type: "artifact_contains"; artifact: string; text: string }
  | { type: "check_passed"; check: string }
  | { type: "github_file_contains"; path: string; text: string; ref?: string }
  | { type: "github_checks_pass"; ref: string }
  | { type: "manual" };

export type CriterionStatus = "pending" | "verified" | "failed";

export interface AcceptanceCriterion {
  id: string;
  projectId: string;
  position: number;
  description: string;
  rule: VerificationRule;
  status: CriterionStatus;
  evidence: string | null;
  feedback: string | null;
  verifiedAt: string | null;
}

export type TaskStatus = "pending" | "in_progress" | "done" | "failed" | "cancelled" | "superseded";
export type TaskSource = "planner" | "agent" | "user";

export interface Task {
  id: string;
  projectId: string;
  position: number;
  title: string;
  description: string;
  actionKind: ActionKind;
  status: TaskStatus;
  source: TaskSource;
  criterionId: string | null;
  attempts: number;
  approvedAt: string | null;
  resultSummary: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DispatchStatus = "in_flight" | "awaiting_handoff" | "succeeded" | "failed" | "abandoned";

export interface Dispatch {
  id: string;
  projectId: string;
  taskId: string;
  idempotencyKey: string;
  adapter: string;
  status: DispatchStatus;
  externalRef: string | null;
  costCents: number;
  summary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type ArtifactKind = "file" | "text" | "link" | "check" | "user_input";

export interface Artifact {
  id: string;
  projectId: string;
  taskId: string | null;
  dispatchId: string | null;
  kind: ArtifactKind;
  name: string;
  content: string;
  contentHash: string;
  source: string;
  simulated: boolean;
  createdAt: string;
}

export const ATTENTION_KINDS = [
  "approval",
  "budget",
  "checkpoint",
  "handoff",
  "blocker",
  "verification",
  "uncertain_dispatch",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export type AttentionStatus = "pending" | "approved" | "rejected" | "responded" | "superseded";
export type AttentionAction = "approve" | "reject" | "respond";

export interface AttentionItem {
  id: string;
  projectId: string;
  projectName?: string;
  taskId: string | null;
  dispatchId: string | null;
  criterionId: string | null;
  kind: AttentionKind;
  title: string;
  detail: string;
  /** Which resolution actions make sense for this item. */
  actions: AttentionAction[];
  status: AttentionStatus;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ActivityEvent {
  id: number;
  projectId: string | null;
  ts: string;
  actor: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
}

export interface Project {
  id: string;
  name: string;
  goal: string;
  constraints: string;
  context: string;
  adapter: string;
  adapterConfig: Record<string, string>;
  state: ProjectState;
  stateReason: string | null;
  autonomy: AutonomyLevel;
  policy: ProjectPolicy;
  limits: ProjectLimits;
  spentCents: number;
  stepsTaken: number;
  stepsSinceCheckpoint: number;
  noProgressSteps: number;
  currentActivity: string | null;
  nextAction: string | null;
  lastProgressAt: string | null;
  lastProgressSummary: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ProjectSummary extends Project {
  criteriaTotal: number;
  criteriaVerified: number;
  pendingAttention: number;
  simulated: boolean;
}

export interface ProjectDetail {
  project: Project;
  adapter: AdapterInfo | null;
  criteria: AcceptanceCriterion[];
  tasks: Task[];
  dispatches: Dispatch[];
  artifacts: Artifact[];
  attention: AttentionItem[];
  events: ActivityEvent[];
}

export type AdapterCategory = "demo" | "model_api" | "code_agent" | "manual_handoff";

export interface AdapterConfigField {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
  help?: string;
}

export interface AdapterInfo {
  id: string;
  name: string;
  category: AdapterCategory;
  /** False for simulated adapters. Simulated work must never be presented as live. */
  live: boolean;
  configured: boolean;
  configurationHint: string | null;
  description: string;
  capabilities: string[];
  limitations: string[];
  configFields: AdapterConfigField[];
  /** Verification rule types this adapter can produce evidence for (besides the generic ones). */
  verificationRules: VerificationRule["type"][];
  /**
   * Whether check results reported by this adapter come from actually executing the check.
   * Self-reported checks (e.g. from a language model) are stored as plain text, never as evidence.
   */
  trustedChecks: boolean;
}

export interface Overview {
  projects: ProjectSummary[];
  attention: AttentionItem[];
  worker: { enabled: boolean; workerId: string };
}

export const DEFAULT_POLICY: ProjectPolicy = {
  requireApproval: ["merge", "spend", "external_communication"],
  deny: [],
  checkpointEvery: 5,
};

export const DEFAULT_LIMITS: ProjectLimits = {
  budgetCents: 500,
  maxSteps: 25,
  maxAttemptsPerTask: 3,
  stallLimit: 3,
};
