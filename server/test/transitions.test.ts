import { describe, expect, it } from "vitest";
import { CommandError } from "../orchestrator/engine.js";
import { README_OK, ScriptedAdapter, completed, setup, waitFor } from "./helpers.js";

describe("orchestration transitions", () => {
  it("runs a demo project from ready to completed with verified evidence", async () => {
    const { orchestrator, store, createProject, settle } = setup();
    const p = createProject({
      criteria: [
        { description: "README has Installation", rule: { type: "artifact_contains", artifact: "README.md", text: "Installation" } },
        { description: "CHANGELOG exists", rule: { type: "artifact_exists", artifact: "CHANGELOG.md" } },
        { description: "Tests pass", rule: { type: "check_passed", check: "unit" } },
      ],
    });
    expect(p.state).toBe("ready");

    // Nothing happens until the user starts the project.
    expect(await orchestrator.tick()).toBe(0);

    orchestrator.start(p.id);
    expect(store.getProject(p.id)!.state).toBe("working");
    await settle();

    const done = store.getProject(p.id)!;
    expect(done.state).toBe("completed");
    expect(done.completedAt).not.toBeNull();
    expect(done.stepsTaken).toBe(3);
    const criteria = store.listCriteria(p.id);
    expect(criteria.every((c) => c.status === "verified")).toBe(true);
    expect(criteria[0].evidence).toMatch(/SIMULATED/); // demo evidence is labelled as simulated
    expect(store.listArtifacts(p.id).every((a) => a.simulated)).toBe(true);
    expect(store.listEvents(p.id).some((e) => e.type === "project_completed")).toBe(true);
  });

  it("rejects commands that are invalid for the current state", () => {
    const { orchestrator, createProject } = setup();
    const p = createProject();
    expect(() => orchestrator.resume(p.id)).toThrow(CommandError);
    orchestrator.start(p.id);
    expect(() => orchestrator.start(p.id)).toThrow(CommandError);
    orchestrator.stop(p.id);
    expect(() => orchestrator.pause(p.id)).toThrow(CommandError);
  });

  it("does not treat the agent saying 'done' as completion", async () => {
    const adapter = new ScriptedAdapter((_req, call) =>
      call === 1
        ? completed([{ name: "README.md", content: "TODO" }], { claimsComplete: true, summary: "All done!" })
        : completed([README_OK]),
    );
    const { orchestrator, store, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);

    await orchestrator.tick();
    expect(store.getProject(p.id)!.state).toBe("working");
    expect(store.listCriteria(p.id)[0].status).toBe("pending");
    expect(store.listEvents(p.id).some((e) => e.type === "unverified_completion_claim")).toBe(true);

    await settle();
    expect(store.getProject(p.id)!.state).toBe("completed");
    expect(adapter.calls).toHaveLength(2);
    // The second attempt was told why the first one failed verification.
    expect(adapter.calls[1].verifierFeedback).toMatch(/does not contain "Installation"/);
  });

  it("requires owner confirmation for manual criteria", async () => {
    const { orchestrator, store, createProject, settle } = setup();
    const p = createProject({ criteria: [{ description: "Tone is right", rule: { type: "manual" } }] });
    orchestrator.start(p.id);
    await settle();

    expect(store.getProject(p.id)!.state).toBe("awaiting_approval");
    const [item] = store.listPendingAttention(p.id);
    expect(item.kind).toBe("verification");

    // Rejecting with feedback creates a new attempt that receives the feedback.
    orchestrator.resolveAttention(item.id, "reject", "Make it friendlier");
    await settle();
    const [again] = store.listPendingAttention(p.id);
    expect(again.kind).toBe("verification");
    expect(again.id).not.toBe(item.id);

    orchestrator.resolveAttention(again.id, "approve", "Looks good");
    await settle();
    expect(store.getProject(p.id)!.state).toBe("completed");
    expect(store.listCriteria(p.id)[0].evidence).toMatch(/Confirmed by the project owner: Looks good/);
  });

  it("blocks instead of looping when a project has no acceptance criteria", async () => {
    const { orchestrator, store, createProject, settle } = setup();
    const p = createProject({ criteria: [] });
    orchestrator.start(p.id);
    await settle();
    expect(store.getProject(p.id)!.state).toBe("blocked");
    expect(store.listPendingAttention(p.id)[0].detail).toMatch(/no acceptance criteria/);
  });
});

describe("pause, resume and stop", () => {
  it("does not dispatch while paused and continues after resume", async () => {
    const { orchestrator, store, createProject, settle } = setup();
    const p = createProject();
    orchestrator.start(p.id);
    orchestrator.pause(p.id);
    expect(await orchestrator.tick()).toBe(0);
    expect(store.listDispatches(p.id)).toHaveLength(0);

    orchestrator.resume(p.id);
    await settle();
    expect(store.getProject(p.id)!.state).toBe("completed");
  });

  it("records a result that arrives after pause, without continuing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adapter = new ScriptedAdapter(async () => {
      await gate;
      return completed([{ name: "notes.md", content: "partial" }]);
    });
    const { orchestrator, store, createProject } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);

    const step = orchestrator.runStep(p.id);
    await waitFor(() => adapter.calls.length === 1);
    orchestrator.pause(p.id);
    release();
    await step;

    const after = store.getProject(p.id)!;
    expect(after.state).toBe("paused");
    expect(store.listDispatches(p.id)[0].status).toBe("succeeded");
    expect(store.listArtifacts(p.id).map((a) => a.name)).toContain("notes.md");
    expect(await orchestrator.tick()).toBe(0);
  });

  it("stop abandons the in-flight dispatch and ignores its late result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adapter = new ScriptedAdapter(async (req) => {
      await gate;
      if (req.signal.aborted) throw new Error("aborted");
      return completed([README_OK]);
    });
    const { orchestrator, store, createProject } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);

    const step = orchestrator.runStep(p.id);
    await waitFor(() => adapter.calls.length === 1);
    orchestrator.stop(p.id);
    release();
    await step;

    expect(store.getProject(p.id)!.state).toBe("stopped");
    expect(store.listDispatches(p.id)[0].status).toBe("abandoned");
    expect(store.listCriteria(p.id)[0].status).toBe("pending");
  });

  it("resuming a blocked project resets exhausted tasks", async () => {
    const adapter = new ScriptedAdapter((_r, call) =>
      call === 1 ? { status: "failed", error: "bad request", retryable: false } : completed([README_OK]),
    );
    const { orchestrator, store, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);
    await settle();
    expect(store.getProject(p.id)!.state).toBe("blocked");

    orchestrator.resume(p.id);
    await settle();
    expect(store.getProject(p.id)!.state).toBe("completed");
  });
});
