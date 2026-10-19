import {
  ACTION_KINDS,
  ALWAYS_GATED_ACTIONS,
  type ActionKind,
  type Project,
  type Task,
} from "../../shared/types.js";

const RANK = new Map<ActionKind, number>(ACTION_KINDS.map((k, i) => [k, i]));

const RULES: Array<[ActionKind, RegExp]> = [
  [
    "destructive",
    /\b(delete|drop|truncate|destroy|wipe|purge|erase|rm\s+-rf|force[- ]?push|reset\s+--hard|revoke|deprovision|tear\s*down)\b/i,
  ],
  [
    "deploy_production",
    /\b(deploy|release|ship|publish|promote|roll\s*out|go\s*live)\b[\s\S]{0,60}\b(prod|production|live|customers)\b|\bproduction\s+(deploy|release|rollout)/i,
  ],
  ["merge", /\bmerge\b[\s\S]{0,40}\b(main|master|default|trunk|release|pull request|pr)\b/i],
  ["spend", /\b(purchase|buy|subscribe|upgrade\s+(the\s+)?plan|payment|pay\s+for|top\s*up|credits?)\b/i],
  ["external_communication", /\b(send\s+(an?\s+)?(email|message|newsletter)|post\s+to|tweet|notify\s+(customers|users)|announce)\b/i],
  ["deploy_staging", /\b(deploy|release)\b[\s\S]{0,40}\b(staging|preview|dev)\b/i],
];

export function isActionKind(value: string): value is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(value);
}

export function maxAction(a: ActionKind, b: ActionKind): ActionKind {
  return (RANK.get(a) ?? 0) >= (RANK.get(b) ?? 0) ? a : b;
}

/**
 * Classify a task. Declared kinds (e.g. from agent output) are untrusted, so the result is the most
 * consequential of the declared kind and what the text implies. Unknown kinds become "other",
 * which always requires approval.
 */
export function classifyAction(title: string, description: string, declared: string): ActionKind {
  let kind: ActionKind = isActionKind(declared) ? declared : "other";
  const text = `${title}\n${description}`;
  for (const [ruleKind, re] of RULES) {
    if (re.test(text)) kind = maxAction(kind, ruleKind);
  }
  return kind;
}

export type GateDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "approval"; reason: string }
  | { type: "budget"; reason: string; requiredBudgetCents: number }
  | { type: "checkpoint"; reason: string };

export function requiresApproval(project: Project, kind: ActionKind): boolean {
  return ALWAYS_GATED_ACTIONS.includes(kind) || project.policy.requireApproval.includes(kind);
}

/** Decide whether a task may be dispatched now under the project's authorization policy. */
export function evaluateGate(project: Project, task: Task, estimateCents: number): GateDecision {
  if (project.policy.deny.includes(task.actionKind)) {
    return { type: "deny", reason: `Action "${task.actionKind}" is not allowed by this project's policy.` };
  }
  if (!task.approvedAt) {
    if (ALWAYS_GATED_ACTIONS.includes(task.actionKind)) {
      return { type: "approval", reason: `"${task.actionKind}" actions always require approval.` };
    }
    if (project.policy.requireApproval.includes(task.actionKind)) {
      return { type: "approval", reason: `Project policy requires approval for "${task.actionKind}" actions.` };
    }
    if (project.autonomy === "manual") {
      return { type: "approval", reason: "Autonomy is set to manual: every step needs approval." };
    }
  }
  if (project.spentCents + estimateCents > project.limits.budgetCents) {
    return {
      type: "budget",
      reason: `This step is estimated at ${fmt(estimateCents)}, which would exceed the remaining budget (${fmt(
        Math.max(0, project.limits.budgetCents - project.spentCents),
      )} of ${fmt(project.limits.budgetCents)}).`,
      requiredBudgetCents: project.spentCents + estimateCents,
    };
  }
  if (
    project.autonomy === "supervised" &&
    project.policy.checkpointEvery > 0 &&
    project.stepsSinceCheckpoint >= project.policy.checkpointEvery
  ) {
    return {
      type: "checkpoint",
      reason: `Supervised mode: review after every ${project.policy.checkpointEvery} steps.`,
    };
  }
  return { type: "allow" };
}

export const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
