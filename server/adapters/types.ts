import type {
  AcceptanceCriterion,
  ActionKind,
  AdapterInfo,
  ArtifactKind,
  VerificationRule,
} from "../../shared/types.js";

/** Everything an adapter receives for one unit of work. Contains no credentials. */
export interface DispatchRequest {
  idempotencyKey: string;
  project: { id: string; name: string; goal: string; constraints: string; context: string };
  task: { id: string; title: string; description: string; actionKind: ActionKind; attempt: number };
  criterion: AcceptanceCriterion | null;
  criteria: AcceptanceCriterion[];
  recentArtifacts: Array<{ kind: ArtifactKind; name: string; content: string }>;
  userGuidance: string[];
  /** Feedback from the verifier about why the previous attempt did not satisfy the criterion. */
  verifierFeedback: string | null;
  config: Record<string, string>;
  signal: AbortSignal;
}

export interface AgentArtifact {
  kind: ArtifactKind;
  name: string;
  content: string;
}

export interface ProposedTask {
  title: string;
  description: string;
  actionKind: ActionKind | string;
}

/** Normalised result of one agent turn. Always treated as untrusted input. */
export interface AgentOutput {
  summary: string;
  artifacts: AgentArtifact[];
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  proposedTasks: ProposedTask[];
  /** The agent's own claim. Recorded, but never sufficient to mark anything complete. */
  claimsComplete: boolean;
  /** A question the agent needs a human to answer. */
  needsInput: string | null;
}

export type DispatchOutcome =
  | { status: "completed"; output: AgentOutput; costCents: number; externalRef?: string }
  | { status: "pending"; externalRef: string; pollAfterMs: number; summary: string; costCents?: number }
  | { status: "handoff"; instructions: string; externalRef?: string }
  | { status: "failed"; error: string; retryable: boolean; retryAfterMs?: number; costCents?: number };

export interface DispatchRef {
  idempotencyKey: string;
  externalRef: string | null;
  config: Record<string, string>;
  signal: AbortSignal;
}

export interface RuleCheckResult {
  passed: boolean;
  evidence: string;
}

export interface ProviderAdapter {
  /** Static description; `configured` / `configurationHint` are filled in by `describe()`. */
  describe(): AdapterInfo;
  /** Validate project-level (non-secret) configuration. Returns a list of problems. */
  validateConfig(config: Record<string, string>): string[];
  /** Upper-bound cost estimate for a dispatch, used for budget gating. */
  estimateCostCents(request: Omit<DispatchRequest, "signal">): number;
  dispatch(request: DispatchRequest): Promise<DispatchOutcome>;
  /** For asynchronous providers: check on a dispatch that returned `pending`. */
  poll?(ref: DispatchRef): Promise<DispatchOutcome>;
  /**
   * After a crash mid-dispatch: determine whether the dispatch was delivered.
   * Return an outcome if it was, or null if it was definitely not delivered (safe to re-dispatch).
   * Adapters without `recover` cause an "uncertain dispatch" escalation instead of a blind retry.
   */
  recover?(ref: DispatchRef): Promise<DispatchOutcome | null>;
  /** Provider-specific verification rules (e.g. read a file from a GitHub repository). */
  checkRule?(rule: VerificationRule, config: Record<string, string>, signal: AbortSignal): Promise<RuleCheckResult | null>;
}

export const EMPTY_OUTPUT: AgentOutput = {
  summary: "",
  artifacts: [],
  checks: [],
  proposedTasks: [],
  claimsComplete: false,
  needsInput: null,
};
