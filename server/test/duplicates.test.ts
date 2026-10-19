import { describe, expect, it } from "vitest";
import { Orchestrator } from "../orchestrator/engine.js";
import { README_OK, ScriptedAdapter, completed, setup } from "./helpers.js";

describe("duplicate and conflict prevention", () => {
  it("concurrent steps for the same project dispatch only once", async () => {
    const adapter = new ScriptedAdapter(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return completed([README_OK]);
    });
    const { orchestrator, store, createProject } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);
    const results = await Promise.all([orchestrator.runStep(p.id), orchestrator.runStep(p.id), orchestrator.tick()]);
    expect(adapter.calls).toHaveLength(1);
    expect(results.filter((r) => r === "busy")).toHaveLength(1);
    expect(store.listDispatches(p.id)).toHaveLength(1);
  });

  it("two workers sharing the database cannot act on the same project at once", async () => {
    const adapter = new ScriptedAdapter(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return completed([README_OK]);
    });
    const { orchestrator, store, registry, createProject } = setup({ adapters: [adapter] });
    const other = new Orchestrator(store, registry, { workerId: "other-worker", stepDelayMs: 0 });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);
    const [a, b] = await Promise.all([orchestrator.runStep(p.id), other.runStep(p.id)]);
    expect([a, b]).toContain("busy");
    expect(adapter.calls).toHaveLength(1);
  });

  it("enforces unique idempotency keys and a single open dispatch per project", () => {
    const { store, createProject } = setup();
    const p = createProject();
    const task = store.createTask({ projectId: p.id, title: "t", description: "", actionKind: "write_code", source: "user" });
    const first = store.createDispatch({ projectId: p.id, taskId: task.id, idempotencyKey: "k1", adapter: "demo" });
    expect(first).not.toBeNull();
    expect(store.createDispatch({ projectId: p.id, taskId: task.id, idempotencyKey: "k1", adapter: "demo" })).toBeNull();
    expect(store.createDispatch({ projectId: p.id, taskId: task.id, idempotencyKey: "k2", adapter: "demo" })).toBeNull();
  });

  it("never asks the same open question twice", () => {
    const { store, createProject } = setup();
    const p = createProject();
    const input = { projectId: p.id, kind: "approval" as const, dedupeKey: "approve:x", title: "t", detail: "d", actions: ["approve" as const] };
    const a = store.raiseAttention(input);
    const b = store.raiseAttention(input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(store.listPendingAttention(p.id)).toHaveLength(1);
  });

  it("asynchronous dispatches are polled, not re-dispatched", async () => {
    const adapter = new ScriptedAdapter(() => ({ status: "pending", externalRef: "issue-7", pollAfterMs: 60_000, summary: "Waiting on issue #7" }));
    let closed = false;
    adapter.pollHandler = () =>
      closed ? completed([README_OK]) : { status: "pending", externalRef: "issue-7", pollAfterMs: 60_000, summary: "Waiting on issue #7" };
    const { orchestrator, store, clock, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);
    await settle();
    expect(store.getProject(p.id)!.currentActivity).toBe("Waiting on issue #7");

    clock.advance(60_000);
    await settle();
    expect(adapter.polls).toHaveLength(1);
    // A transient error while checking does not create new work at the provider.
    adapter.pollHandler = () => ({ status: "failed", error: "HTTP 502", retryable: true });
    clock.advance(60_000);
    await settle();
    expect(adapter.calls).toHaveLength(1);

    adapter.pollHandler = () => (closed ? completed([README_OK]) : { status: "pending", externalRef: "issue-7", pollAfterMs: 60_000, summary: "" });
    closed = true;
    clock.advance(60_000);
    await settle();
    expect(adapter.calls).toHaveLength(1);
    expect(store.getProject(p.id)!.state).toBe("completed");
  });
});

describe("restart recovery", () => {
  it("resumes after a crash mid-dispatch without duplicating delivered work", async () => {
    const adapter = new ScriptedAdapter(() => completed([README_OK]));
    adapter.recover = async () => completed([README_OK]); // the provider confirms the work was delivered
    const { orchestrator, store, registry, clock, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);
    // Simulate a crash: dispatch recorded and lease held by a worker that died.
    const task = store.createTask({ projectId: p.id, title: "Satisfy", description: "", actionKind: "write_code", source: "planner", criterionId: store.listCriteria(p.id)[0].id });
    store.updateTask(task.id, { status: "in_progress", attempts: 1 });
    store.createDispatch({ projectId: p.id, taskId: task.id, idempotencyKey: `${task.id}:1`, adapter: "scripted" });
    store.acquireLease(p.id, "dead-worker", 1000);

    const restarted = new Orchestrator(store, registry, { workerId: "new-worker", stepDelayMs: 0 });
    expect(await restarted.tick()).toBe(0); // lease still valid
    clock.advance(2000);
    await restarted.tick();
    await settle();
    expect(adapter.calls).toHaveLength(0);
    expect(store.getProject(p.id)!.state).toBe("completed");
  });

  it("re-dispatches an interrupted dispatch the provider confirms was never delivered", async () => {
    const { orchestrator, store, createProject, settle } = setup();
    const p = createProject();
    orchestrator.start(p.id);
    const task = store.createTask({ projectId: p.id, title: "Satisfy", description: "", actionKind: "write_code", source: "planner", criterionId: store.listCriteria(p.id)[0].id });
    store.updateTask(task.id, { status: "in_progress", attempts: 1 });
    store.createDispatch({ projectId: p.id, taskId: task.id, idempotencyKey: `${task.id}:1`, adapter: "demo" });
    await settle();
    expect(store.getProject(p.id)!.state).toBe("completed");
    expect(store.listDispatches(p.id).map((d) => d.status).sort()).toEqual(["abandoned", "succeeded"]);
  });

  it("asks the user when delivery of an interrupted dispatch cannot be determined", async () => {
    const adapter = new ScriptedAdapter(() => completed([README_OK])); // no recover()
    const { orchestrator, store, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);
    const task = store.createTask({ projectId: p.id, title: "x", description: "", actionKind: "write_code", source: "user" });
    store.createDispatch({ projectId: p.id, taskId: task.id, idempotencyKey: `${task.id}:1`, adapter: "scripted" });
    await settle();
    expect(store.getProject(p.id)!.state).toBe("awaiting_approval");
    const [item] = store.listPendingAttention(p.id);
    expect(item.kind).toBe("uncertain_dispatch");
    expect(adapter.calls).toHaveLength(0);
    orchestrator.resolveAttention(item.id, "approve", null);
    await settle();
    expect(store.getProject(p.id)!.state).toBe("completed");
  });

  it("persists state across store instances (file-backed database)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { Store } = await import("../store.js");
    const dir = mkdtempSync(join(tmpdir(), "orchestrai-"));
    try {
      const path = join(dir, "test.db");
      const s1 = new Store(path);
      const created = s1.createProject({
        name: "Persisted",
        goal: "g",
        constraints: "",
        context: "",
        adapter: "demo",
        adapterConfig: {},
        autonomy: "supervised",
        policy: { requireApproval: [], deny: [], checkpointEvery: 0 },
        limits: { budgetCents: 100, maxSteps: 5, maxAttemptsPerTask: 2, stallLimit: 2 },
        criteria: [{ description: "c", rule: { type: "manual" } }],
      });
      s1.updateProject(created.id, { state: "working", spentCents: 42 });
      s1.close();
      const s2 = new Store(path);
      const reloaded = s2.getProject(created.id)!;
      expect(reloaded.state).toBe("working");
      expect(reloaded.spentCents).toBe(42);
      expect(s2.listCriteria(created.id)).toHaveLength(1);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
