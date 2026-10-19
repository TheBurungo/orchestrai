import type {
  AttentionAction,
  AttentionItem,
  Dispatch,
  Project,
  ProjectState,
  Task,
} from "../../shared/types.js";
import { normalizeOutput } from "../adapters/output.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { AgentOutput, DispatchOutcome, DispatchRequest, ProviderAdapter } from "../adapters/types.js";
import { artifactHash, type Clock, type Store } from "../store.js";
import { classifyAction, evaluateGate, fmt } from "./policy.js";
import { planNext, previewNext } from "./planner.js";
import { verifyCriteria } from "./verifier.js";

export interface EngineOptions {
  workerId: string;
  /** Base delay for exponential retry backoff. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Pause between consecutive successful steps of one project. */
  stepDelayMs: number;
  /** Abort a single adapter call after this long. */
  dispatchTimeoutMs: number;
  /** Give up on an asynchronous (pending) dispatch after this long. */
  maxPendingMs: number;
  /** Hard cap on tasks per project, so agents cannot create unbounded work. */
  maxTasksPerProject: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  workerId: `worker-${process.pid}`,
  backoffBaseMs: 2_000,
  backoffMaxMs: 5 * 60_000,
  stepDelayMs: 500,
  dispatchTimeoutMs: 10 * 60_000,
  maxPendingMs: 7 * 24 * 3_600_000,
  maxTasksPerProject: 100,
};

export type StepResult =
  | "skipped"
  | "busy"
  | "dispatched"
  | "pending"
  | "retry_scheduled"
  | "awaiting_approval"
  | "blocked"
  | "completed"
  | "stopped"
  | "duplicate"
  | "recovered"
  | "error";

export class CommandError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

const ACTIVE_STATES: ProjectState[] = ["working", "ready", "awaiting_approval", "blocked", "paused"];

/**
 * The orchestration loop. Every state change is persisted, so work resumes after a restart.
 * Each `step` performs at most one dispatch for one project while holding that project's lease.
 */
export class Orchestrator {
  readonly options: EngineOptions;
  private readonly running = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    readonly store: Store,
    readonly adapters: AdapterRegistry,
    options: Partial<EngineOptions> = {},
  ) {
    this.options = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  }

  private get clock(): Clock {
    return this.store.clock;
  }

  private nowPlus(ms: number): string {
    return new Date(this.clock().getTime() + ms).toISOString();
  }

  private leaseTtl(): number {
    return this.options.dispatchTimeoutMs * 2 + 60_000;
  }

  // ===================================================================== worker

  /** Process every project that is due. Returns the number of projects stepped. */
  async tick(maxConcurrent = 4): Promise<number> {
    const capacity = maxConcurrent - this.running.size;
    if (capacity <= 0) return 0;
    const due = this.store
      .listDueProjects(maxConcurrent * 2)
      .filter((p) => !this.running.has(p.id))
      .slice(0, capacity);
    await Promise.all(due.map((p) => this.runStep(p.id)));
    return due.length;
  }

  /** Run one step for a project under its lease. Safe to call concurrently; extra calls return "busy". */
  async runStep(projectId: string): Promise<StepResult> {
    if (this.running.has(projectId)) return "busy";
    if (!this.store.acquireLease(projectId, this.options.workerId, this.leaseTtl())) return "busy";
    this.running.add(projectId);
    try {
      return await this.step(projectId);
    } catch (err) {
      const p = this.store.getProject(projectId);
      this.store.log(projectId, "orchestrator", "step_error", `Orchestrator error: ${(err as Error).message}`);
      if (p) {
        const delay = this.backoff(p.noProgressSteps + 1);
        this.store.updateProject(projectId, { noProgressSteps: p.noProgressSteps + 1, nextRunAt: this.nowPlus(delay) }, ["working"]);
      }
      return "error";
    } finally {
      this.running.delete(projectId);
      this.store.releaseLease(projectId, this.options.workerId);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(this.options.backoffBaseMs * 2 ** Math.max(0, attempt - 1), this.options.backoffMaxMs);
  }

  private async step(projectId: string): Promise<StepResult> {
    const p = this.store.getProject(projectId);
    if (!p || p.state !== "working") return "skipped";
    const adapter = this.adapters.get(p.adapter);
    if (!adapter) {
      return this.block(p, `Adapter "${p.adapter}" is not available on this server.`, `adapter:${p.adapter}`);
    }

    const open = this.store.getOpenDispatch(p.id);
    if (open) return this.continueOpenDispatch(p, adapter, open);

    if (p.spentCents >= p.limits.budgetCents) {
      return this.stopForLimit(p, `Budget limit reached: ${fmt(p.spentCents)} spent of ${fmt(p.limits.budgetCents)}.`);
    }
    if (p.stepsTaken >= p.limits.maxSteps) {
      return this.stopForLimit(p, `Step limit reached: ${p.stepsTaken} of ${p.limits.maxSteps} dispatches used.`);
    }

    // No dispatch is open, so nothing can legitimately be in progress (e.g. after an unclean shutdown).
    for (const t of this.store.listTasks(p.id)) {
      if (t.status === "in_progress") this.store.updateTask(t.id, { status: "pending" });
    }

    await this.verify(p, adapter);
    if (this.allVerified(p.id)) return this.complete(p);

    const plan = planNext(this.store, p);
    switch (plan.kind) {
      case "idle":
        if (this.store.listCriteria(p.id).length === 0) {
          return this.block(p, "This project has no acceptance criteria, so completion cannot be verified. Add criteria to continue.", "no-criteria");
        }
        return this.block(p, "No actionable task could be determined.", "no-task");
      case "exhausted":
        return this.raiseAndWait(p, "blocked", {
          kind: "blocker",
          dedupeKey: `exhausted:${plan.task.id}`,
          taskId: plan.task.id,
          title: `Task needs direction: ${plan.task.title}`,
          detail: `The task did not succeed after ${plan.task.attempts} attempt(s).\nLast error: ${plan.task.lastError ?? "unknown"}\n\nRespond with guidance to retry it, or reject to stop the project.`,
          actions: ["respond", "reject"],
        });
      case "verify_manual":
        return this.raiseAndWait(p, "awaiting_approval", {
          kind: "verification",
          dedupeKey: `verify:${plan.criterion.id}`,
          criterionId: plan.criterion.id,
          title: `Confirm acceptance: ${plan.criterion.description}`,
          detail: "This criterion is verified by you. Review the artifacts, then approve if it is met or reject with feedback.",
          actions: ["approve", "reject"],
        });
      case "task":
        return this.gateAndDispatch(p, adapter, plan.task);
    }
  }

  private async gateAndDispatch(p: Project, adapter: ProviderAdapter, task: Task): Promise<StepResult> {
    const estimate = adapter.estimateCostCents(this.buildRequest(p, task));
    const gate = evaluateGate(p, task, estimate);
    switch (gate.type) {
      case "deny":
        this.store.updateTask(task.id, { status: "cancelled", lastError: gate.reason });
        this.store.log(p.id, "orchestrator", "action_denied", `Denied "${task.title}": ${gate.reason}`, { taskId: task.id });
        if (task.source === "agent") {
          // Disallowed agent suggestions are simply dropped; continue with other work.
          this.store.updateProject(p.id, { nextRunAt: this.nowPlus(0) }, ["working"]);
          return "skipped";
        }
        return this.raiseAndWait(p, "blocked", {
          kind: "blocker",
          dedupeKey: `denied:${task.id}`,
          taskId: task.id,
          title: `Required work is not permitted: ${task.title}`,
          detail: `${gate.reason}\nAdjust the policy or respond with an alternative approach.`,
          actions: ["respond", "reject"],
        });
      case "approval":
        return this.raiseAndWait(p, "awaiting_approval", {
          kind: "approval",
          dedupeKey: `approve:${task.id}`,
          taskId: task.id,
          title: `Approve ${task.actionKind.replace(/_/g, " ")}: ${task.title}`,
          detail: `${gate.reason}\n\n${task.description || "(no description)"}\nProposed by: ${task.source}. Estimated cost: ${fmt(estimate)}.`,
          actions: ["approve", "reject"],
        });
      case "budget":
        return this.raiseAndWait(p, "awaiting_approval", {
          kind: "budget",
          dedupeKey: `budget:${task.id}`,
          taskId: task.id,
          title: `Raise budget to ${fmt(gate.requiredBudgetCents)} for: ${task.title}`,
          detail: `${gate.reason}\nApprove to raise the project budget to ${fmt(gate.requiredBudgetCents)}; reject to pause.`,
          actions: ["approve", "reject"],
        });
      case "checkpoint":
        return this.raiseAndWait(p, "awaiting_approval", {
          kind: "checkpoint",
          dedupeKey: `checkpoint:${p.stepsTaken}`,
          title: `Checkpoint after ${p.stepsSinceCheckpoint} steps`,
          detail: `${gate.reason}\nLast progress: ${p.lastProgressSummary ?? "none yet"}\nNext: ${task.title}\nApprove to continue or reject to pause.`,
          actions: ["approve", "reject"],
        });
      case "allow":
        return this.dispatch(p, adapter, task);
    }
  }

  private buildRequest(p: Project, task: Task, attempt = task.attempts + 1): Omit<DispatchRequest, "signal"> {
    const seq = this.store.nextDispatchSeq(task.id);
    const criteria = this.store.listCriteria(p.id);
    const artifacts = this.store.listArtifacts(p.id);
    const criterion = task.criterionId ? (criteria.find((c) => c.id === task.criterionId) ?? null) : null;
    return {
      idempotencyKey: `${task.id}:${seq}`,
      project: { id: p.id, name: p.name, goal: p.goal, constraints: p.constraints, context: p.context },
      task: { id: task.id, title: task.title, description: task.description, actionKind: task.actionKind, attempt },
      criterion,
      criteria,
      recentArtifacts: artifacts
        .filter((a) => a.kind !== "user_input")
        .slice(0, 5)
        .map((a) => ({ kind: a.kind, name: a.name, content: a.content.slice(0, 8000) })),
      userGuidance: artifacts
        .filter((a) => a.kind === "user_input")
        .slice(0, 10)
        .reverse()
        .map((a) => a.content),
      verifierFeedback: criterion?.feedback ?? null,
      config: p.adapterConfig,
    };
  }

  private async dispatch(p: Project, adapter: ProviderAdapter, task: Task): Promise<StepResult> {
    // Verification awaited I/O; the user may have paused or stopped the project in the meantime.
    if (this.store.getProject(p.id)?.state !== "working") return "skipped";
    const attempt = task.attempts + 1;
    const request = this.buildRequest(p, task, attempt);
    // The unique idempotency key and the one-open-dispatch-per-project index make duplicates impossible.
    const d = this.store.createDispatch({
      projectId: p.id,
      taskId: task.id,
      idempotencyKey: request.idempotencyKey,
      adapter: p.adapter,
    });
    if (!d) {
      this.store.log(p.id, "orchestrator", "duplicate_dispatch_prevented", `Skipped duplicate dispatch for "${task.title}"`, {
        idempotencyKey: request.idempotencyKey,
      });
      this.store.updateProject(p.id, { nextRunAt: this.nowPlus(this.backoff(1)) }, ["working"]);
      return "duplicate";
    }
    const info = adapter.describe();
    this.store.updateTask(task.id, { status: "in_progress", attempts: attempt });
    this.store.updateProject(
      p.id,
      {
        currentActivity: `${info.live ? "" : "[DEMO] "}Working on "${task.title}" via ${info.name} (attempt ${attempt})`,
        nextAction: "Collect and verify the result",
      },
      ["working"],
    );
    this.store.log(p.id, "orchestrator", "dispatch_started", `Dispatched "${task.title}" to ${info.name} (attempt ${attempt})`, {
      dispatchId: d.id,
      idempotencyKey: d.idempotencyKey,
      actionKind: task.actionKind,
      simulated: !info.live,
    });

    const controller = new AbortController();
    this.controllers.set(p.id, controller);
    const timer = setTimeout(() => controller.abort(), this.options.dispatchTimeoutMs);
    let outcome: DispatchOutcome;
    try {
      outcome = await adapter.dispatch({ ...request, signal: controller.signal });
    } catch (err) {
      outcome = {
        status: "failed",
        error: controller.signal.aborted ? "Dispatch timed out or was cancelled" : (err as Error).message,
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(p.id);
    }
    return this.applyOutcome(p.id, task.id, d.id, outcome);
  }

  private async continueOpenDispatch(p: Project, adapter: ProviderAdapter, d: Dispatch): Promise<StepResult> {
    if (d.status === "awaiting_handoff") {
      const item = this.store.listAttention(p.id).find((a) => a.dispatchId === d.id && a.kind === "handoff");
      if (item?.status === "responded") {
        const task = this.store.getTask(d.taskId);
        const output = this.outputFromHandoff(item.resolution ?? "", task, p);
        return this.applyOutcome(p.id, d.taskId, d.id, { status: "completed", output, costCents: 0 });
      }
      return this.moveTo(p, "awaiting_approval", "Waiting for you to relay the prompt and paste the response.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.dispatchTimeoutMs);
    const ref = { idempotencyKey: d.idempotencyKey, externalRef: d.externalRef, config: p.adapterConfig, signal: controller.signal };
    try {
      if (d.externalRef && adapter.poll) {
        if (this.clock().getTime() - new Date(d.startedAt).getTime() > this.options.maxPendingMs) {
          return this.applyOutcome(p.id, d.taskId, d.id, {
            status: "failed",
            error: `No result from ${adapter.describe().name} after ${Math.round(this.options.maxPendingMs / 3_600_000)}h`,
            retryable: false,
          });
        }
        let outcome: DispatchOutcome;
        try {
          outcome = await adapter.poll(ref);
        } catch (err) {
          outcome = { status: "failed", error: (err as Error).message, retryable: true };
        }
        if (outcome.status === "failed" && outcome.retryable) {
          // A transient error while *checking* must not re-dispatch (that would duplicate external work).
          const failures = p.noProgressSteps + 1;
          if (failures >= p.limits.maxAttemptsPerTask) {
            this.store.updateProject(p.id, { noProgressSteps: failures }, ["working"]);
            return this.raiseAndWait(p, "blocked", {
              kind: "blocker",
              dedupeKey: `poll:${d.id}`,
              dispatchId: d.id,
              taskId: d.taskId,
              title: "Cannot check on dispatched work",
              detail: `Checking ${d.externalRef} failed ${failures} times in a row: ${outcome.error}\nRespond to try again, or reject to stop.`,
              actions: ["respond", "reject"],
            });
          }
          const delay = Math.max(this.backoff(failures), outcome.retryAfterMs ?? 0);
          this.store.log(p.id, `adapter:${d.adapter}`, "poll_failed", `Could not check on the dispatch; retrying in ${Math.round(delay / 1000)}s: ${outcome.error}`);
          this.store.updateProject(p.id, { noProgressSteps: failures, nextRunAt: this.nowPlus(delay) }, ["working"]);
          return "retry_scheduled";
        }
        return this.applyOutcome(p.id, d.taskId, d.id, outcome);
      }

      // In flight without an external reference: the process stopped mid-dispatch.
      if (adapter.recover) {
        let recovered: DispatchOutcome | null;
        try {
          recovered = await adapter.recover(ref);
        } catch (err) {
          return this.uncertain(p, d, `Could not determine whether the interrupted dispatch was delivered: ${(err as Error).message}`);
        }
        if (recovered) {
          this.store.log(p.id, "orchestrator", "dispatch_recovered", "Found the interrupted dispatch at the provider; resuming it", {
            dispatchId: d.id,
          });
          return this.applyOutcome(p.id, d.taskId, d.id, recovered);
        }
        this.store.updateDispatch(d.id, ["in_flight"], { status: "abandoned", error: "Interrupted before delivery; safe to retry" });
        this.store.updateTask(d.taskId, { status: "pending" });
        this.store.log(p.id, "orchestrator", "dispatch_recovered", "Interrupted dispatch was not delivered; it will be retried", {
          dispatchId: d.id,
        });
        this.store.updateProject(p.id, { nextRunAt: this.nowPlus(0) }, ["working"]);
        return "recovered";
      }
      return this.uncertain(p, d, "The process stopped while this dispatch was in progress and the provider cannot confirm delivery.");
    } finally {
      clearTimeout(timer);
    }
  }

  private uncertain(p: Project, d: Dispatch, reason: string): StepResult {
    return this.raiseAndWait(p, "awaiting_approval", {
      kind: "uncertain_dispatch",
      dedupeKey: `uncertain:${d.id}`,
      dispatchId: d.id,
      taskId: d.taskId,
      title: "Interrupted dispatch – retry?",
      detail: `${reason}\nApprove to retry (this may duplicate work at the provider) or reject to pause the project.`,
      actions: ["approve", "reject"],
    });
  }

  private outputFromHandoff(text: string, task: Task | null, p: Project): AgentOutput {
    // Structured replies in the agent output format are accepted, but parsed as untrusted input.
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      try {
        return normalizeOutput(JSON.parse(trimmed));
      } catch {
        /* fall through to plain text */
      }
    }
    const criterion = task?.criterionId ? this.store.getCriterion(task.criterionId) : null;
    const rule = criterion?.rule;
    const name =
      rule && (rule.type === "artifact_exists" || rule.type === "artifact_contains")
        ? rule.artifact
        : `handoff-response-${(task?.id ?? p.id).slice(0, 8)}.md`;
    return {
      summary: "Response relayed by the project owner",
      artifacts: [{ kind: "file", name, content: text }],
      checks: [],
      proposedTasks: [],
      claimsComplete: false,
      needsInput: null,
    };
  }

  private async applyOutcome(projectId: string, taskId: string, dispatchId: string, outcome: DispatchOutcome): Promise<StepResult> {
    const p = this.store.getProject(projectId);
    const task = this.store.getTask(taskId);
    const d = this.store.getDispatch(dispatchId);
    if (!p || !task || !d) return "skipped";
    if (d.status !== "in_flight" && d.status !== "awaiting_handoff") {
      this.store.log(p.id, "orchestrator", "late_result_ignored", `Ignored a result for a dispatch that was already ${d.status}`, {
        dispatchId,
      });
      return "skipped";
    }
    const adapter = this.adapters.get(d.adapter);
    const actor = `adapter:${d.adapter}`;

    switch (outcome.status) {
      case "pending": {
        const cost = outcome.costCents ?? 0;
        this.store.updateDispatch(d.id, ["in_flight"], { externalRef: outcome.externalRef, costCents: d.costCents + cost });
        this.store.addSpend(p.id, cost);
        if (!d.externalRef) {
          this.store.updateProject(p.id, { stepsTaken: p.stepsTaken + 1, stepsSinceCheckpoint: p.stepsSinceCheckpoint + 1 });
          this.store.log(p.id, actor, "dispatch_pending", outcome.summary, { externalRef: outcome.externalRef });
        }
        this.store.updateProject(
          p.id,
          { currentActivity: outcome.summary, nextAction: "Check the provider for a result", nextRunAt: this.nowPlus(outcome.pollAfterMs) },
          ["working"],
        );
        return "pending";
      }

      case "handoff": {
        this.store.updateDispatch(d.id, ["in_flight"], { status: "awaiting_handoff", externalRef: outcome.externalRef });
        this.store.updateProject(p.id, { stepsTaken: p.stepsTaken + 1, stepsSinceCheckpoint: p.stepsSinceCheckpoint + 1 });
        this.store.log(p.id, actor, "handoff_prepared", `Prepared a manual handoff for "${task.title}"`, { dispatchId: d.id });
        return this.raiseAndWait(p, "awaiting_approval", {
          kind: "handoff",
          dedupeKey: `handoff:${d.id}`,
          dispatchId: d.id,
          taskId: task.id,
          title: `Relay to ${p.adapterConfig.target || "your AI tool"}: ${task.title}`,
          detail: outcome.instructions,
          actions: ["respond", "reject"],
        }, "Waiting for you to relay the prompt and paste the response.");
      }

      case "failed": {
        const cost = outcome.costCents ?? 0;
        this.store.updateDispatch(d.id, ["in_flight", "awaiting_handoff"], { status: "failed", error: outcome.error, costCents: d.costCents + cost });
        this.store.addSpend(p.id, cost);
        const fresh = this.store.getProject(p.id)!;
        this.store.updateProject(p.id, {
          stepsTaken: fresh.stepsTaken + (d.externalRef ? 0 : 1),
          stepsSinceCheckpoint: fresh.stepsSinceCheckpoint + (d.externalRef ? 0 : 1),
        });
        this.store.updateTask(task.id, { lastError: outcome.error });
        if (!outcome.retryable || task.attempts >= p.limits.maxAttemptsPerTask) {
          this.store.updateTask(task.id, { status: "failed" });
          this.store.log(p.id, actor, "task_failed", `"${task.title}" failed: ${outcome.error}`, { attempts: task.attempts });
          return this.raiseAndWait(this.store.getProject(p.id)!, "blocked", {
            kind: "blocker",
            dedupeKey: `exhausted:${task.id}`,
            taskId: task.id,
            title: `Task needs direction: ${task.title}`,
            detail: `${outcome.retryable ? `Failed after ${task.attempts} attempt(s)` : "Failed with a non-retryable error"}: ${outcome.error}\n\nRespond with guidance to retry, or reject to stop the project.`,
            actions: ["respond", "reject"],
          });
        }
        this.store.updateTask(task.id, { status: "pending" });
        const delay = Math.max(this.backoff(task.attempts), outcome.retryAfterMs ?? 0);
        this.store.log(p.id, actor, "dispatch_failed", `Attempt ${task.attempts} of "${task.title}" failed; retrying in ${Math.round(delay / 1000)}s: ${outcome.error}`);
        this.store.updateProject(
          p.id,
          {
            currentActivity: `Retrying "${task.title}" after an error`,
            nextAction: `Retry attempt ${task.attempts + 1} of ${p.limits.maxAttemptsPerTask}`,
            nextRunAt: this.nowPlus(delay),
          },
          ["working"],
        );
        return "retry_scheduled";
      }

      case "completed":
        return this.applyOutput(p, task, d, adapter, outcome.output, outcome.costCents, outcome.externalRef);
    }
  }

  private async applyOutput(
    p: Project,
    task: Task,
    d: Dispatch,
    adapter: ProviderAdapter | undefined,
    rawOutput: AgentOutput,
    costCents: number,
    externalRef?: string,
  ): Promise<StepResult> {
    let output: AgentOutput;
    try {
      output = normalizeOutput(rawOutput); // untrusted, even from our own adapters
    } catch (err) {
      return this.applyOutcome(p.id, task.id, d.id, { status: "failed", error: (err as Error).message, retryable: true, costCents });
    }
    if (!this.store.updateDispatch(d.id, ["in_flight", "awaiting_handoff"], {
      status: "succeeded",
      summary: output.summary,
      costCents: d.costCents + costCents,
      externalRef,
    })) {
      return "skipped";
    }
    this.store.addSpend(p.id, costCents);
    const info = adapter?.describe();
    const simulated = info ? !info.live : false;
    const fromUser = d.status === "awaiting_handoff";
    const source = fromUser ? "user (handoff)" : `adapter:${d.adapter}`;

    // Record artifacts and measure novelty.
    const newArtifacts: string[] = [];
    for (const a of output.artifacts) {
      if (!this.store.hasArtifactHash(p.id, artifactHash(a.kind, a.name, a.content), d.id)) newArtifacts.push(a.name);
      this.store.addArtifact({ projectId: p.id, taskId: task.id, dispatchId: d.id, kind: a.kind, name: a.name, content: a.content, source, simulated });
    }
    for (const c of output.checks) {
      const content = `${c.passed ? "PASSED" : "FAILED"}${c.detail ? `: ${c.detail}` : ""}`;
      const trusted = !!info?.trustedChecks && !fromUser;
      const kind = trusted ? "check" : "text";
      const name = trusted ? c.name : `reported check: ${c.name}`;
      if (!this.store.hasArtifactHash(p.id, artifactHash(kind, name, content), d.id)) newArtifacts.push(name);
      this.store.addArtifact({ projectId: p.id, taskId: task.id, dispatchId: d.id, kind, name, content, source, simulated });
    }

    // Agent-proposed tasks are untrusted: classify independently and cap the total.
    let existing = this.store.listTasks(p.id).length;
    for (const pt of output.proposedTasks) {
      if (existing >= this.options.maxTasksPerProject) {
        this.store.log(p.id, "orchestrator", "task_cap_reached", `Ignored proposed task "${pt.title}": task limit reached`);
        break;
      }
      const kind = classifyAction(pt.title, pt.description, pt.actionKind);
      this.store.createTask({ projectId: p.id, title: pt.title, description: pt.description, actionKind: kind, source: "agent" });
      existing++;
      this.store.log(p.id, source, "task_proposed", `Agent proposed "${pt.title}" (classified as ${kind})`, {
        declaredKind: pt.actionKind,
        classifiedKind: kind,
      });
    }

    this.store.log(p.id, source, "dispatch_completed", output.summary || "Agent turn completed", {
      dispatchId: d.id,
      artifacts: output.artifacts.map((a) => a.name),
      costCents,
      claimsComplete: output.claimsComplete,
      simulated,
    });

    // Verify against evidence.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.dispatchTimeoutMs);
    let results;
    try {
      results = await verifyCriteria(this.store, adapter, p, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    const newlyVerified = results.filter((r) => r.passed);
    for (const r of newlyVerified) {
      this.store.log(p.id, "verifier", "criterion_verified", `Verified: ${r.criterion.description}`, { evidence: r.evidence });
    }
    const allVerified = this.allVerified(p.id);
    if (output.claimsComplete && !allVerified) {
      this.store.log(p.id, "verifier", "unverified_completion_claim", "The agent claimed completion, but acceptance criteria are not yet verified; continuing.");
    }

    // Task outcome.
    const fresh = this.store.getProject(p.id)!;
    const criterion = task.criterionId ? this.store.getCriterion(task.criterionId) : null;
    let taskExhausted = false;
    if (output.needsInput) {
      this.store.updateTask(task.id, { status: "pending", resultSummary: output.summary });
    } else if (!criterion || criterion.rule.type === "manual" || criterion.status === "verified") {
      this.store.updateTask(task.id, { status: "done", resultSummary: output.summary });
    } else if (task.attempts >= fresh.limits.maxAttemptsPerTask) {
      this.store.updateTask(task.id, { status: "failed", resultSummary: output.summary, lastError: `Not verified: ${criterion.feedback ?? ""}` });
      taskExhausted = true;
    } else {
      this.store.updateTask(task.id, { status: "pending", resultSummary: output.summary, lastError: `Not verified: ${criterion.feedback ?? ""}` });
    }

    // Progress accounting and stall detection.
    const manualDeliverable = criterion?.rule.type === "manual" && !output.needsInput && newArtifacts.length > 0;
    const progressed = newlyVerified.length > 0 || newArtifacts.length > 0 || manualDeliverable;
    const progressSummary = newlyVerified.length
      ? `Verified: ${newlyVerified.map((r) => r.criterion.description).join("; ")}`
      : newArtifacts.length
        ? `New artifacts: ${newArtifacts.join(", ")}`
        : null;
    const steps = fromUser ? 0 : d.externalRef ? 0 : 1;
    this.store.updateProject(p.id, {
      stepsTaken: fresh.stepsTaken + steps,
      stepsSinceCheckpoint: fresh.stepsSinceCheckpoint + steps,
      noProgressSteps: progressed ? 0 : fresh.noProgressSteps + 1,
      ...(progressed ? { lastProgressAt: this.store.now(), lastProgressSummary: progressSummary } : {}),
      currentActivity: `Last result: ${output.summary || "agent turn completed"}`,
    });
    const after = this.store.getProject(p.id)!;

    if (allVerified) return this.complete(after);
    if (output.needsInput) {
      return this.raiseAndWait(after, "blocked", {
        kind: "blocker",
        dedupeKey: `question:${d.id}`,
        taskId: task.id,
        title: "The agent needs your input",
        detail: output.needsInput,
        actions: ["respond", "reject"],
      });
    }
    if (taskExhausted) {
      return this.raiseAndWait(after, "blocked", {
        kind: "blocker",
        dedupeKey: `exhausted:${task.id}`,
        taskId: task.id,
        title: `Task needs direction: ${task.title}`,
        detail: `After ${task.attempts} attempt(s) the result still does not meet the criterion.\nVerifier: ${criterion?.feedback ?? "not verified"}\n\nRespond with guidance to retry, or reject to stop the project.`,
        actions: ["respond", "reject"],
      });
    }
    if (after.noProgressSteps >= after.limits.stallLimit) {
      this.store.log(p.id, "orchestrator", "stalled", `No measurable progress in ${after.noProgressSteps} consecutive steps`);
      return this.raiseAndWait(after, "blocked", {
        kind: "blocker",
        dedupeKey: `stall:${after.stepsTaken}`,
        taskId: task.id,
        title: "Work has stalled",
        detail: `${after.noProgressSteps} consecutive steps produced no new artifacts and verified no criteria. Repeating the same prompt is unlikely to help.\nLast agent summary: ${output.summary || "(none)"}\n\nRespond with guidance to try a different approach, or reject to stop.`,
        actions: ["respond", "reject"],
      });
    }
    this.store.updateProject(p.id, { nextAction: this.describeNext(after), nextRunAt: this.nowPlus(this.options.stepDelayMs) }, ["working"]);
    return "dispatched";
  }

  // ===================================================================== state helpers

  private allVerified(projectId: string): boolean {
    const criteria = this.store.listCriteria(projectId);
    return criteria.length > 0 && criteria.every((c) => c.status === "verified");
  }

  private async verify(p: Project, adapter: ProviderAdapter): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.dispatchTimeoutMs);
    try {
      const results = await verifyCriteria(this.store, adapter, p, controller.signal);
      for (const r of results.filter((x) => x.passed)) {
        this.store.log(p.id, "verifier", "criterion_verified", `Verified: ${r.criterion.description}`, { evidence: r.evidence });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private describeNext(p: Project): string {
    const next = previewNext(this.store, p);
    switch (next.kind) {
      case "task":
        return `Next: ${next.title}`;
      case "exhausted":
        return `Needs direction: ${next.title}`;
      case "verify_manual":
        return `Owner confirmation: ${next.description}`;
      case "idle":
        return "Verify completion";
    }
  }

  private complete(p: Project): StepResult {
    const evidence = this.store.listCriteria(p.id).map((c) => ({ criterion: c.description, evidence: c.evidence }));
    const ok = this.store.updateProject(
      p.id,
      {
        state: "completed",
        stateReason: "All acceptance criteria verified",
        completedAt: this.store.now(),
        currentActivity: "Completed – all acceptance criteria verified",
        nextAction: null,
        nextRunAt: null,
      },
      ["working"],
    );
    if (ok) {
      this.store.supersedeAttention(p.id, "Project completed");
      this.store.log(p.id, "orchestrator", "project_completed", "All acceptance criteria verified; project complete", { evidence });
    }
    return "completed";
  }

  private stopForLimit(p: Project, reason: string): StepResult {
    if (this.store.updateProject(p.id, { state: "stopped", stateReason: reason, nextAction: "Raise the limit in Settings, then resume", nextRunAt: null, currentActivity: "Stopped: limit reached" }, ["working"])) {
      this.store.log(p.id, "orchestrator", "limit_reached", reason);
    }
    return "stopped";
  }

  private block(p: Project, reason: string, key: string): StepResult {
    return this.raiseAndWait(p, "blocked", {
      kind: "blocker",
      dedupeKey: `block:${key}`,
      title: "Project is blocked",
      detail: reason,
      actions: ["respond", "reject"],
    });
  }

  private moveTo(p: Project, state: ProjectState, reason: string): StepResult {
    this.store.updateProject(p.id, { state, stateReason: reason, nextRunAt: null, nextAction: reason }, ["working"]);
    return state === "blocked" ? "blocked" : "awaiting_approval";
  }

  private raiseAndWait(
    p: Project,
    state: "awaiting_approval" | "blocked",
    item: {
      kind: AttentionItem["kind"];
      dedupeKey: string;
      title: string;
      detail: string;
      actions: AttentionAction[];
      taskId?: string;
      dispatchId?: string;
      criterionId?: string;
    },
    reason?: string,
  ): StepResult {
    const { item: raised, created } = this.store.raiseAttention({ projectId: p.id, ...item });
    if (created) {
      this.store.log(p.id, "orchestrator", state === "blocked" ? "escalated_blocker" : "approval_requested", raised.title, {
        attentionId: raised.id,
        kind: raised.kind,
      });
    }
    this.store.updateProject(
      p.id,
      { state, stateReason: reason ?? raised.title, nextAction: `Your decision: ${raised.title}`, nextRunAt: null },
      ["working"],
    );
    return state === "blocked" ? "blocked" : "awaiting_approval";
  }

  // ===================================================================== user commands

  private requireProject(id: string): Project {
    const p = this.store.getProject(id);
    if (!p) throw new CommandError("Project not found", 404);
    return p;
  }

  start(id: string): Project {
    const p = this.requireProject(id);
    if (p.state !== "ready") throw new CommandError(`Cannot start a project that is ${p.state}`);
    this.store.updateProject(id, { state: "working", stateReason: "Started by user", nextRunAt: null, currentActivity: "Starting", nextAction: this.describeNext(p) }, ["ready"]);
    this.store.log(id, "user", "project_started", "Project started");
    return this.requireProject(id);
  }

  pause(id: string): Project {
    const p = this.requireProject(id);
    if (!["working", "ready", "awaiting_approval", "blocked"].includes(p.state)) throw new CommandError(`Cannot pause a project that is ${p.state}`);
    this.store.updateProject(id, { state: "paused", stateReason: "Paused by user", nextRunAt: null, nextAction: "Resume when ready" }, [p.state]);
    this.store.log(id, "user", "project_paused", "Project paused");
    return this.requireProject(id);
  }

  resume(id: string): Project {
    const p = this.requireProject(id);
    if (!["paused", "stopped", "blocked"].includes(p.state)) throw new CommandError(`Cannot resume a project that is ${p.state}`);
    if (p.spentCents >= p.limits.budgetCents) throw new CommandError("Budget limit reached. Raise the budget in Settings before resuming.");
    if (p.stepsTaken >= p.limits.maxSteps) throw new CommandError("Step limit reached. Raise the step limit in Settings before resuming.");
    this.store.tx(() => {
      if (p.state === "blocked") {
        for (const item of this.store.listPendingAttention(id).filter((a) => a.kind === "blocker")) {
          this.store.resolveAttention(item.id, "responded", "Resumed by user without additional guidance");
        }
        this.resetFailedTasks(id);
      }
      const pending = this.store.listPendingAttention(id).length;
      this.store.updateProject(
        id,
        {
          state: pending ? "awaiting_approval" : "working",
          stateReason: "Resumed by user",
          noProgressSteps: 0,
          nextRunAt: null,
          currentActivity: pending ? "Waiting for your decisions" : "Resuming",
        },
        [p.state],
      );
    });
    this.store.log(id, "user", "project_resumed", "Project resumed");
    return this.requireProject(id);
  }

  stop(id: string): Project {
    const p = this.requireProject(id);
    if (!ACTIVE_STATES.includes(p.state)) throw new CommandError(`Cannot stop a project that is ${p.state}`);
    this.store.tx(() => {
      const open = this.store.getOpenDispatch(id);
      if (open) {
        this.store.updateDispatch(open.id, ["in_flight", "awaiting_handoff"], { status: "abandoned", error: "Stopped by user" });
        this.store.updateTask(open.taskId, { status: "pending" });
      }
      this.store.supersedeAttention(id, "Project stopped by user");
      this.store.updateProject(id, { state: "stopped", stateReason: "Stopped by user", nextRunAt: null, currentActivity: "Stopped", nextAction: "Resume to continue" }, [p.state]);
    });
    this.controllers.get(id)?.abort();
    this.store.log(id, "user", "project_stopped", "Project stopped");
    return this.requireProject(id);
  }

  private resetFailedTasks(projectId: string): void {
    for (const t of this.store.listTasks(projectId)) {
      if (t.status === "failed") this.store.updateTask(t.id, { status: "pending", attempts: 0 });
    }
  }

  addGuidance(projectId: string, text: string): void {
    this.requireProject(projectId);
    this.store.addArtifact({ projectId, kind: "user_input", name: "Owner guidance", content: text, source: "user", simulated: false });
    this.store.log(projectId, "user", "guidance_added", "Added guidance for the agent");
  }

  addTask(projectId: string, input: { title: string; description: string; actionKind: string }): Task {
    const p = this.requireProject(projectId);
    if (p.state === "completed") throw new CommandError("Project is already completed");
    const kind = classifyAction(input.title, input.description, input.actionKind);
    const task = this.store.createTask({ projectId, title: input.title, description: input.description, actionKind: kind, source: "user" });
    this.store.log(projectId, "user", "task_added", `Added task "${task.title}" (${kind})`, { taskId: task.id });
    return task;
  }

  resolveAttention(itemId: string, action: AttentionAction, note: string | null): AttentionItem {
    const item = this.store.getAttention(itemId);
    if (!item) throw new CommandError("Attention item not found", 404);
    if (item.status !== "pending") throw new CommandError(`This item was already ${item.status}`);
    if (!item.actions.includes(action)) throw new CommandError(`"${action}" is not a valid response to this item`, 400);
    const p = this.requireProject(item.projectId);
    const text = note?.trim() || null;
    let next: ProjectState | null = null; // explicit state change, if any
    let nextReason = "";

    this.store.tx(() => {
      switch (item.kind) {
        case "approval":
          if (action === "approve") {
            if (item.taskId) this.store.updateTask(item.taskId, { approvedAt: this.store.now() });
          } else {
            const task = item.taskId ? this.store.getTask(item.taskId) : null;
            if (task?.criterionId) {
              // Required work was rejected: a human must choose another approach.
              this.store.updateTask(task.id, { status: "failed", lastError: `Rejected by owner${text ? `: ${text}` : ""}` });
            } else if (task) {
              this.store.updateTask(task.id, { status: "cancelled", lastError: `Rejected by owner${text ? `: ${text}` : ""}` });
            }
          }
          break;
        case "budget":
          if (action === "approve") {
            const task = item.taskId ? this.store.getTask(item.taskId) : null;
            const adapter = this.adapters.get(p.adapter);
            const estimate = task && adapter ? adapter.estimateCostCents(this.buildRequest(p, task)) : 0;
            const budgetCents = Math.max(p.limits.budgetCents, p.spentCents + estimate);
            this.store.updateProject(p.id, { limits: { ...p.limits, budgetCents } });
            this.store.log(p.id, "user", "budget_raised", `Budget raised from ${fmt(p.limits.budgetCents)} to ${fmt(budgetCents)}`);
          } else {
            next = "paused";
            nextReason = "Budget increase declined";
          }
          break;
        case "checkpoint":
          if (action === "approve") this.store.updateProject(p.id, { stepsSinceCheckpoint: 0 });
          else {
            next = "paused";
            nextReason = "Paused at checkpoint";
          }
          break;
        case "handoff":
          if (action === "respond") {
            if (!text) throw new CommandError("Paste the response from the AI tool", 400);
          } else {
            const d = item.dispatchId ? this.store.getDispatch(item.dispatchId) : null;
            if (d) {
              this.store.updateDispatch(d.id, ["awaiting_handoff"], { status: "abandoned", error: "Handoff declined by owner" });
              this.store.updateTask(d.taskId, { status: "pending" });
            }
            next = "paused";
            nextReason = "Handoff declined";
          }
          break;
        case "blocker":
          if (action === "respond") {
            if (text) {
              this.store.addArtifact({ projectId: p.id, taskId: item.taskId, kind: "user_input", name: "Owner guidance", content: text, source: "user", simulated: false });
            }
            this.resetFailedTasks(p.id);
            this.store.updateProject(p.id, { noProgressSteps: 0 });
          } else {
            next = "stopped";
            nextReason = "Stopped by owner";
          }
          break;
        case "verification":
          if (item.criterionId) {
            if (action === "approve") {
              this.store.updateCriterion(item.criterionId, {
                status: "verified",
                evidence: `Confirmed by the project owner${text ? `: ${text}` : ""}`,
                feedback: null,
              });
            } else {
              this.store.updateCriterion(item.criterionId, { status: "failed", feedback: text ?? "Rejected by the project owner" });
              for (const t of this.store.listTasks(p.id)) {
                if (t.criterionId === item.criterionId && t.status === "done") this.store.updateTask(t.id, { status: "superseded" });
              }
            }
          }
          break;
        case "uncertain_dispatch": {
          const d = item.dispatchId ? this.store.getDispatch(item.dispatchId) : null;
          if (d) {
            this.store.updateDispatch(d.id, ["in_flight"], { status: "abandoned", error: "Interrupted; outcome unknown" });
            this.store.updateTask(d.taskId, { status: "pending" });
          }
          if (action === "reject") {
            next = "paused";
            nextReason = "Paused after an interrupted dispatch";
          }
          break;
        }
      }

      const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "responded";
      this.store.resolveAttention(item.id, status, text);
      if (next) {
        if (next === "stopped") this.store.supersedeAttention(p.id, nextReason);
        this.store.updateProject(p.id, { state: next, stateReason: nextReason, nextRunAt: null, nextAction: "Resume when ready" }, [
          "awaiting_approval",
          "blocked",
          "working",
        ]);
      } else if (this.store.listPendingAttention(p.id).length === 0) {
        this.store.updateProject(p.id, { state: "working", stateReason: "Decision received", nextRunAt: null, nextAction: "Continuing" }, [
          "awaiting_approval",
          "blocked",
        ]);
      }
    });
    this.store.log(p.id, "user", "attention_resolved", `${action} – ${item.title}`, { attentionId: item.id, kind: item.kind, note: text });
    return this.store.getAttention(itemId)!;
  }
}
