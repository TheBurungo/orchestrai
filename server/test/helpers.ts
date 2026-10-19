import type { AdapterInfo } from "../../shared/types.js";
import { DEFAULT_LIMITS, DEFAULT_POLICY } from "../../shared/types.js";
import { DemoAdapter } from "../adapters/demo.js";
import { ManualHandoffAdapter } from "../adapters/manual.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { AgentOutput, DispatchOutcome, DispatchRef, DispatchRequest, ProviderAdapter } from "../adapters/types.js";
import { Orchestrator, type EngineOptions } from "../orchestrator/engine.js";
import { Store, type NewProjectInput } from "../store.js";

export class FakeClock {
  t = new Date("2026-01-01T00:00:00.000Z").getTime();
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

type Handler = (req: DispatchRequest, call: number) => Promise<DispatchOutcome> | DispatchOutcome;

/** A fully scriptable adapter for tests. */
export class ScriptedAdapter implements ProviderAdapter {
  calls: DispatchRequest[] = [];
  polls: DispatchRef[] = [];
  pollHandler: (ref: DispatchRef) => Promise<DispatchOutcome> | DispatchOutcome = () => {
    throw new Error("no poll handler");
  };
  estimate = 1;
  recover?: (ref: DispatchRef) => Promise<DispatchOutcome | null>;

  constructor(
    public handler: Handler,
    private readonly id = "scripted",
  ) {}

  describe(): AdapterInfo {
    return {
      id: this.id,
      name: "Scripted test adapter",
      category: "model_api",
      live: true,
      configured: true,
      configurationHint: null,
      description: "",
      capabilities: [],
      limitations: [],
      configFields: [],
      verificationRules: [],
      trustedChecks: true,
    };
  }
  validateConfig() {
    return [];
  }
  estimateCostCents() {
    return this.estimate;
  }
  async dispatch(req: DispatchRequest) {
    this.calls.push(req);
    return this.handler(req, this.calls.length);
  }
  async poll(ref: DispatchRef) {
    this.polls.push(ref);
    return this.pollHandler(ref);
  }
}

export function completed(
  artifacts: Array<{ name: string; content: string }>,
  extra: Partial<AgentOutput> = {},
  costCents = 1,
): DispatchOutcome {
  return {
    status: "completed",
    costCents,
    output: {
      summary: "did work",
      artifacts: artifacts.map((a) => ({ kind: "file" as const, ...a })),
      checks: [],
      proposedTasks: [],
      claimsComplete: false,
      needsInput: null,
      ...extra,
    },
  };
}

export function setup(opts: { adapters?: ProviderAdapter[]; engine?: Partial<EngineOptions> } = {}) {
  const clock = new FakeClock();
  const store = new Store(":memory:", clock.now);
  const registry = new AdapterRegistry().register(new DemoAdapter({ delayMs: 0 })).register(new ManualHandoffAdapter());
  for (const a of opts.adapters ?? []) registry.register(a);
  const orchestrator = new Orchestrator(store, registry, {
    workerId: "test-worker",
    stepDelayMs: 0,
    backoffBaseMs: 1000,
    backoffMaxMs: 60_000,
    dispatchTimeoutMs: 5_000,
    ...opts.engine,
  });

  const createProject = (input: Partial<NewProjectInput> = {}) =>
    store.createProject({
      name: "Test project",
      goal: "Do the thing",
      constraints: "",
      context: "",
      adapter: "demo",
      adapterConfig: { delayMs: "0" },
      autonomy: "autonomous",
      policy: { ...DEFAULT_POLICY, checkpointEvery: 0 },
      limits: { ...DEFAULT_LIMITS },
      criteria: [
        { description: "README has Installation", rule: { type: "artifact_contains", artifact: "README.md", text: "Installation" } },
      ],
      ...input,
    });

  /** Tick until nothing is due (bounded, so a runaway loop fails the test instead of hanging). */
  const settle = async (max = 50) => {
    for (let i = 0; i < max; i++) {
      if ((await orchestrator.tick()) === 0) return i;
    }
    throw new Error("did not settle");
  };

  return { clock, store, registry, orchestrator, createProject, settle };
}

export const README_OK = { name: "README.md", content: "# App\n\n## Installation\n\nnpm install" };

export async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}
