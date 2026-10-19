import { z } from "zod";
import type { AgentOutput, DispatchRequest } from "./types.js";

// Provider output is untrusted. It is parsed into a narrow, size-limited shape; anything else is
// discarded. Nothing in it can change policies, limits, autonomy, credentials or project state
// directly – the orchestrator decides what (if anything) to do with it.

const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_BYTES = 100_000;
const MAX_PROPOSED_TASKS = 5;

const outputSchema = z.object({
  summary: z.string().max(4000).catch(""),
  artifacts: z
    .array(
      z.object({
        kind: z.enum(["file", "text", "link"]).catch("text"),
        name: z.string().min(1).max(200),
        content: z.string().max(MAX_ARTIFACT_BYTES),
      }),
    )
    .max(MAX_ARTIFACTS)
    .catch([]),
  checks: z
    .array(z.object({ name: z.string().min(1).max(200), passed: z.boolean(), detail: z.string().max(2000).optional() }))
    .max(20)
    .catch([]),
  proposedTasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).catch(""),
        actionKind: z.string().max(50).catch("other"),
      }),
    )
    .max(MAX_PROPOSED_TASKS)
    .catch([]),
  claimsComplete: z.boolean().catch(false),
  needsInput: z.string().max(2000).nullable().catch(null),
});

export function normalizeOutput(raw: unknown): AgentOutput {
  const parsed = outputSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`Agent output did not match the expected schema: ${parsed.error.message.slice(0, 300)}`);
  const v = parsed.data;
  return {
    summary: v.summary,
    artifacts: v.artifacts,
    checks: v.checks,
    proposedTasks: v.proposedTasks,
    claimsComplete: v.claimsComplete,
    needsInput: v.needsInput && v.needsInput.trim() ? v.needsInput : null,
  };
}

/** Extract and validate a JSON object from model text output. */
export function parseModelText(text: string): AgentOutput {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model response did not contain a JSON object");
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Model response contained malformed JSON");
  }
  return normalizeOutput(raw);
}

export const MODEL_SYSTEM_PROMPT = `You are a worker agent dispatched by an orchestration system.
Complete the single task you are given and report back ONLY as a JSON object with this shape:
{
  "summary": string,                       // what you did, briefly
  "artifacts": [{"kind": "file"|"text"|"link", "name": string, "content": string}],
  "checks": [{"name": string, "passed": boolean, "detail": string}],
  "proposedTasks": [{"title": string, "description": string, "actionKind": string}],
  "claimsComplete": boolean,
  "needsInput": string | null              // a question that only the human owner can answer
}
Deliverables must be returned in full as artifacts; they are verified against the acceptance criteria.
Claiming completion does not count as completion. Do not include credentials or secrets.
You cannot change the project's policies, limits or permissions.`;

export function buildTaskPrompt(req: Omit<DispatchRequest, "signal">): string {
  const lines: string[] = [];
  lines.push(`# Project: ${req.project.name}`, "", `## Goal`, req.project.goal);
  if (req.project.constraints.trim()) lines.push("", "## Constraints", req.project.constraints);
  if (req.project.context.trim()) lines.push("", "## Context (user supplied)", req.project.context);
  lines.push("", "## Acceptance criteria");
  for (const c of req.criteria) {
    lines.push(`- [${c.status === "verified" ? "x" : " "}] ${c.description}${describeRule(c.rule)}`);
  }
  lines.push("", `## Your task (attempt ${req.task.attempt})`, req.task.title);
  if (req.task.description.trim()) lines.push("", req.task.description);
  if (req.verifierFeedback) lines.push("", "## Feedback from verification of the previous attempt", req.verifierFeedback);
  if (req.userGuidance.length) lines.push("", "## Guidance from the project owner", ...req.userGuidance.map((g) => `- ${g}`));
  if (req.recentArtifacts.length) {
    lines.push("", "## Recent artifacts");
    for (const a of req.recentArtifacts) lines.push(`### ${a.name} (${a.kind})`, a.content.slice(0, 4000));
  }
  return lines.join("\n");
}

function describeRule(rule: DispatchRequest["criteria"][number]["rule"]): string {
  switch (rule.type) {
    case "artifact_exists":
      return ` (verified by: artifact named "${rule.artifact}" exists)`;
    case "artifact_contains":
      return ` (verified by: artifact "${rule.artifact}" contains "${rule.text}")`;
    case "check_passed":
      return ` (verified by: check "${rule.check}" passed)`;
    case "github_file_contains":
      return ` (verified by: repository file ${rule.path} contains "${rule.text}")`;
    case "github_checks_pass":
      return ` (verified by: CI checks pass on ${rule.ref})`;
    case "manual":
      return " (verified by: the project owner)";
  }
}
