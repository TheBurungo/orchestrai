import { describe, expect, it } from "vitest";
import { README_OK, ScriptedAdapter, completed, setup } from "./helpers.js";

describe("limits, retries and stall detection", () => {
  it("asks before exceeding the budget and stops when it is exhausted", async () => {
    const adapter = new ScriptedAdapter((_r, call) => completed([{ name: `n${call}.md`, content: String(call) }], {}, 300));
    adapter.estimate = 300;
    const { orchestrator, store, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({
      adapter: "scripted",
      limits: { budgetCents: 500, maxSteps: 100, maxAttemptsPerTask: 10, stallLimit: 10 },
    });
    orchestrator.start(p.id);
    await settle();

    expect(adapter.calls).toHaveLength(1);
    expect(store.getProject(p.id)!.state).toBe("awaiting_approval");
    const [item] = store.listPendingAttention(p.id);
    expect(item.kind).toBe("budget");

    orchestrator.resolveAttention(item.id, "approve", null);
    expect(store.getProject(p.id)!.limits.budgetCents).toBe(600);
    await settle();

    expect(adapter.calls).toHaveLength(2);
    const stopped = store.getProject(p.id)!;
    expect(stopped.state).toBe("stopped");
    expect(stopped.stateReason).toMatch(/Budget limit reached/);
    expect(() => orchestrator.resume(p.id)).toThrow(/Raise the budget/);
  });

  it("declining a budget increase pauses the project", async () => {
    const adapter = new ScriptedAdapter(() => completed([README_OK]));
    adapter.estimate = 1000;
    const { orchestrator, store, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);
    await settle();
    const [item] = store.listPendingAttention(p.id);
    orchestrator.resolveAttention(item.id, "reject", null);
    expect(store.getProject(p.id)!.state).toBe("paused");
    expect(adapter.calls).toHaveLength(0);
  });

  it("stops at the step limit", async () => {
    const adapter = new ScriptedAdapter((_r, call) => completed([{ name: `n${call}.md`, content: String(call) }]));
    const { orchestrator, store, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted", limits: { budgetCents: 1000, maxSteps: 3, maxAttemptsPerTask: 10, stallLimit: 10 } });
    orchestrator.start(p.id);
    await settle();
    expect(adapter.calls).toHaveLength(3);
    expect(store.getProject(p.id)!.state).toBe("stopped");
    expect(store.getProject(p.id)!.stateReason).toMatch(/Step limit/);

    store.updateProject(p.id, { limits: { budgetCents: 1000, maxSteps: 4, maxAttemptsPerTask: 10, stallLimit: 10 } });
    orchestrator.resume(p.id);
    await settle();
    expect(adapter.calls).toHaveLength(4);
  });

  it("retries transient failures with exponential backoff, then escalates", async () => {
    const adapter = new ScriptedAdapter(() => ({ status: "failed", error: "HTTP 503", retryable: true }));
    const { orchestrator, store, clock, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted", limits: { budgetCents: 1000, maxSteps: 100, maxAttemptsPerTask: 3, stallLimit: 10 } });
    orchestrator.start(p.id);

    await settle();
    expect(adapter.calls).toHaveLength(1);
    const firstRetry = new Date(store.getProject(p.id)!.nextRunAt!).getTime() - clock.t;
    expect(firstRetry).toBe(1000);

    clock.advance(999);
    expect(await orchestrator.tick()).toBe(0); // not yet due
    clock.advance(1);
    await settle();
    expect(adapter.calls).toHaveLength(2);
    expect(new Date(store.getProject(p.id)!.nextRunAt!).getTime() - clock.t).toBe(2000);

    clock.advance(2000);
    await settle();
    expect(adapter.calls).toHaveLength(3);
    expect(store.getProject(p.id)!.state).toBe("blocked");
    const [item] = store.listPendingAttention(p.id);
    expect(item.kind).toBe("blocker");

    // Guidance re-enables the task; it is passed to the agent.
    adapter.handler = () => completed([README_OK]);
    orchestrator.resolveAttention(item.id, "respond", "Use the EU endpoint");
    await settle();
    expect(adapter.calls[3].userGuidance).toEqual(["Use the EU endpoint"]);
    expect(store.getProject(p.id)!.state).toBe("completed");
  });

  it("honours provider Retry-After over the default backoff", async () => {
    const adapter = new ScriptedAdapter(() => ({ status: "failed", error: "HTTP 429", retryable: true, retryAfterMs: 30_000 }));
    const { orchestrator, store, clock, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);
    await settle();
    expect(new Date(store.getProject(p.id)!.nextRunAt!).getTime() - clock.t).toBe(30_000);
  });

  it("detects repeated prompts that produce no progress", async () => {
    const adapter = new ScriptedAdapter(() => completed([{ name: "notes.md", content: "same notes" }], { claimsComplete: true }));
    const { orchestrator, store, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted", limits: { budgetCents: 1000, maxSteps: 100, maxAttemptsPerTask: 20, stallLimit: 2 } });
    orchestrator.start(p.id);
    await settle();
    // 1st call produced a new artifact (progress); 2nd and 3rd repeated it.
    expect(adapter.calls).toHaveLength(3);
    const blocked = store.getProject(p.id)!;
    expect(blocked.state).toBe("blocked");
    expect(store.listPendingAttention(p.id)[0].title).toBe("Work has stalled");
    expect(store.listEvents(p.id).some((e) => e.type === "stalled")).toBe(true);
  });

  it("bounds attempts per task even when every attempt produces new content", async () => {
    const adapter = new ScriptedAdapter((_r, call) => completed([{ name: "README.md", content: `draft ${call}` }]));
    const { orchestrator, store, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted", limits: { budgetCents: 1000, maxSteps: 100, maxAttemptsPerTask: 2, stallLimit: 10 } });
    orchestrator.start(p.id);
    await settle();
    expect(adapter.calls).toHaveLength(2);
    expect(store.getProject(p.id)!.state).toBe("blocked");
  });

  it("escalates agent questions to the user and passes the answer back", async () => {
    const { orchestrator, store, createProject, settle } = setup();
    const p = createProject({ adapterConfig: { delayMs: "0", scenario: "needs_input" } });
    orchestrator.start(p.id);
    await settle();
    expect(store.getProject(p.id)!.state).toBe("blocked");
    const [item] = store.listPendingAttention(p.id);
    expect(item.detail).toMatch(/audience/);
    orchestrator.resolveAttention(item.id, "respond", "Developers");
    await settle();
    expect(store.getProject(p.id)!.state).toBe("completed");
  });
});

describe("manual handoff", () => {
  it("hands off a prompt, accepts the pasted response and verifies it", async () => {
    const { orchestrator, store, createProject, settle } = setup();
    const p = createProject({ adapter: "manual", adapterConfig: { target: "ChatGPT Project" } });
    orchestrator.start(p.id);
    await settle();
    expect(store.getProject(p.id)!.state).toBe("awaiting_approval");
    const [item] = store.listPendingAttention(p.id);
    expect(item.kind).toBe("handoff");
    expect(item.detail).toContain("----- PROMPT -----");
    expect(item.detail).toContain("README has Installation");

    expect(() => orchestrator.resolveAttention(item.id, "respond", "")).toThrow();
    orchestrator.resolveAttention(item.id, "respond", "# README\n\n## Installation\nRun npm install.");
    await settle();
    expect(store.getProject(p.id)!.state).toBe("completed");
    const artifact = store.listArtifacts(p.id).find((a) => a.name === "README.md")!;
    expect(artifact.source).toBe("user (handoff)");
    expect(artifact.simulated).toBe(false);
  });
});
