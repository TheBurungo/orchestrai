import { describe, expect, it } from "vitest";
import { normalizeOutput, parseModelText } from "../adapters/output.js";
import { redact, registerSecret } from "../security/redact.js";
import { ScriptedAdapter, completed, setup } from "./helpers.js";

describe("secret redaction", () => {
  it("masks common credential formats", () => {
    // Fake values assembled at runtime so no credential-shaped literal lives in the source.
    const fakes = {
      openai: ["sk", "proj", "a".repeat(24)].join("-"),
      anthropic: ["sk", "ant", "api03", "b".repeat(16)].join("-"),
      github: ["gh", "p_", "c".repeat(36)].join(""),
      bearer: ["Bearer", "d".repeat(12) + ".e".repeat(4)].join(" "),
      password: ["pass", "word=", "f".repeat(10)].join(""),
    };
    const out = redact(Object.values(fakes).join("\n"));
    expect(out).not.toContain("a".repeat(24));
    expect(out).not.toContain("b".repeat(16));
    expect(out).not.toContain("c".repeat(36));
    expect(out).not.toContain("d".repeat(12));
    expect(out).not.toContain("f".repeat(10));
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(5);
  });

  it("masks registered secret values wherever they appear", () => {
    registerSecret("my-very-private-value-123");
    expect(redact("token is my-very-private-value-123!")).toBe("token is [REDACTED]!");
  });

  it("never persists secrets from agent output into artifacts or the audit log", async () => {
    const leaked = ["sk", "proj", "z".repeat(28)].join("-");
    const adapter = new ScriptedAdapter(() => completed([{ name: "README.md", content: `Installation: export OPENAI_API_KEY=${leaked}` }], { summary: `used ${leaked}` }));
    const { orchestrator, store, createProject, settle } = setup({ adapters: [adapter] });
    const p = createProject({ adapter: "scripted" });
    orchestrator.start(p.id);
    await settle();
    const everything = JSON.stringify({ a: store.listArtifacts(p.id), e: store.listEvents(p.id), d: store.listDispatches(p.id) });
    expect(everything).not.toContain(leaked);
  });
});

describe("redaction on project updates", () => {
  it("redacts secrets pasted into context or adapter settings", () => {
    const { store, createProject } = setup();
    const p = createProject();
    const fake = ["sk", "proj", "q".repeat(26)].join("-");
    store.updateProject(p.id, { context: `notes ${fake}`, adapterConfig: { scenario: fake }, currentActivity: `using ${fake}` });
    const after = store.getProject(p.id)!;
    expect(JSON.stringify(after)).not.toContain("q".repeat(26));
    expect(after.context).toContain("[REDACTED]");
    expect(after.state).toBe("ready");
  });
});

describe("untrusted agent output parsing", () => {
  it("extracts a JSON object and drops unknown fields", () => {
    const out = parseModelText('Sure! {"summary":"ok","artifacts":[{"kind":"file","name":"a.md","content":"x"}],"policy":{"deny":[]},"claimsComplete":true}');
    expect(out.summary).toBe("ok");
    expect(out.artifacts).toHaveLength(1);
    expect(out).not.toHaveProperty("policy");
  });

  it("rejects non-JSON model output", () => {
    expect(() => parseModelText("I finished everything, trust me.")).toThrow();
  });

  it("caps oversized collections instead of trusting them", () => {
    const out = normalizeOutput({ summary: "x", proposedTasks: Array.from({ length: 50 }, (_, i) => ({ title: `t${i}`, description: "", actionKind: "read" })) });
    expect(out.proposedTasks).toEqual([]);
  });
});
