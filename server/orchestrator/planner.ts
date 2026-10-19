import type { AcceptanceCriterion, Project, Task } from "../../shared/types.js";
import type { Store } from "../store.js";
import { classifyAction } from "./policy.js";

export type PlanStep =
  | { kind: "task"; task: Task }
  /** A manual criterion has a finished deliverable and needs the owner's confirmation. */
  | { kind: "verify_manual"; criterion: AcceptanceCriterion }
  /** A task ran out of attempts (or was rejected); a human must decide how to proceed. */
  | { kind: "exhausted"; task: Task }
  /** Nothing left to do: either everything is verified or there are no criteria. */
  | { kind: "idle" };

export type PlanPreview =
  | { kind: "task"; title: string }
  | { kind: "verify_manual"; description: string }
  | { kind: "exhausted"; title: string }
  | { kind: "idle" };

function analyse(tasks: Task[], criteria: AcceptanceCriterion[]) {
  const pending = tasks.find((t) => t.status === "pending");
  if (pending) return { kind: "task" as const, task: pending };
  const failed = tasks.find((t) => t.status === "failed");
  if (failed) return { kind: "exhausted" as const, task: failed };

  let awaitingManual: AcceptanceCriterion | null = null;
  for (const c of criteria) {
    if (c.status === "verified") continue;
    const forCriterion = tasks.filter((t) => t.criterionId === c.id);
    if (forCriterion.some((t) => t.status === "in_progress")) return { kind: "busy" as const };
    if (c.rule.type === "manual" && forCriterion.some((t) => t.status === "done")) {
      awaitingManual ??= c;
      continue;
    }
    return { kind: "new_task" as const, criterion: c };
  }
  if (awaitingManual) return { kind: "verify_manual" as const, criterion: awaitingManual };
  return { kind: "idle" as const };
}

/**
 * Determine the next actionable step. Explicit pending tasks (from the user or proposed by the agent)
 * run first in creation order; otherwise a task is created for the first unverified criterion.
 */
export function planNext(store: Store, project: Project): PlanStep {
  const tasks = store.listTasks(project.id);
  const criteria = store.listCriteria(project.id);
  const a = analyse(tasks, criteria);
  switch (a.kind) {
    case "task":
    case "exhausted":
    case "verify_manual":
    case "idle":
      return a;
    case "busy":
      return { kind: "idle" };
    case "new_task": {
      const c = a.criterion;
      const task = store.createTask({
        projectId: project.id,
        title: `Satisfy: ${c.description}`,
        description: c.feedback ? `Previous verification feedback: ${c.feedback}` : "",
        actionKind: classifyAction(c.description, "", "write_code"),
        source: "planner",
        criterionId: c.id,
      });
      store.log(project.id, "orchestrator", "task_planned", `Planned task "${task.title}"`, { taskId: task.id });
      return { kind: "task", task };
    }
  }
}

/** Describe what will happen next without creating anything. */
export function previewNext(store: Store, project: Project): PlanPreview {
  const a = analyse(store.listTasks(project.id), store.listCriteria(project.id));
  switch (a.kind) {
    case "task":
      return { kind: "task", title: a.task.title };
    case "exhausted":
      return { kind: "exhausted", title: a.task.title };
    case "verify_manual":
      return { kind: "verify_manual", description: a.criterion.description };
    case "new_task":
      return { kind: "task", title: `Satisfy: ${a.criterion.description}` };
    default:
      return { kind: "idle" };
  }
}
