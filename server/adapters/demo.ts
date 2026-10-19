import type { AdapterInfo } from "../../shared/types.js";
import type { AgentOutput, DispatchOutcome, DispatchRequest, ProviderAdapter } from "./types.js";

export const DEMO_SCENARIOS = ["happy", "flaky", "claims_done", "needs_approval", "needs_input", "stall"] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

const TAG = "[DEMO – simulated]";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}

/**
 * A local, deterministic simulation of an agent. It performs no real work and contacts no service.
 * Everything it produces is tagged as simulated and the UI labels such projects "DEMO".
 */
export class DemoAdapter implements ProviderAdapter {
  constructor(private readonly defaults: { delayMs: number } = { delayMs: 1200 }) {}

  describe(): AdapterInfo {
    return {
      id: "demo",
      name: "Demo agent (simulated)",
      category: "demo",
      live: false,
      configured: true,
      configurationHint: null,
      description:
        "Deterministic local simulation for trying the orchestrator end to end. It does not call any AI provider and its output is not real work.",
      capabilities: [
        "Simulates agent turns that produce artifacts and test checks",
        "Scenarios: happy path, transient failures, premature 'done' claims, gated deployments, questions for the owner, stalls",
      ],
      limitations: ["Produces placeholder content only", "Cannot satisfy GitHub verification rules"],
      configFields: [
        {
          key: "scenario",
          label: "Scenario",
          required: false,
          options: [...DEMO_SCENARIOS],
          help: "Which behaviour to simulate.",
        },
        { key: "delayMs", label: "Simulated latency (ms)", required: false, placeholder: "1200" },
        { key: "costCents", label: "Simulated cost per turn (cents)", required: false, placeholder: "2" },
      ],
      verificationRules: [],
      trustedChecks: true,
    };
  }

  validateConfig(config: Record<string, string>): string[] {
    const errors: string[] = [];
    if (config.scenario && !DEMO_SCENARIOS.includes(config.scenario as DemoScenario)) {
      errors.push(`scenario must be one of ${DEMO_SCENARIOS.join(", ")}`);
    }
    for (const key of ["delayMs", "costCents"]) {
      if (config[key] !== undefined && config[key] !== "" && !/^\d+$/.test(config[key])) errors.push(`${key} must be a whole number`);
    }
    return errors;
  }

  private cost(config: Record<string, string>): number {
    return config.costCents ? Number(config.costCents) : 2;
  }

  estimateCostCents(req: Omit<DispatchRequest, "signal">): number {
    return this.cost(req.config);
  }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    const scenario = (req.config.scenario as DemoScenario) || "happy";
    const delay = req.config.delayMs ? Number(req.config.delayMs) : this.defaults.delayMs;
    await sleep(delay, req.signal);
    const costCents = this.cost(req.config);
    const attempt = req.task.attempt;

    if (scenario === "flaky" && attempt === 1) {
      return { status: "failed", error: `${TAG} Transient provider error (HTTP 503)`, retryable: true, costCents: 0 };
    }

    if (scenario === "stall") {
      return {
        status: "completed",
        costCents,
        output: {
          summary: `${TAG} Still investigating; no deliverable yet.`,
          artifacts: [{ kind: "text", name: "investigation-notes.md", content: `${TAG} Investigation notes (unchanged).` }],
          checks: [],
          proposedTasks: [],
          claimsComplete: true,
          needsInput: null,
        },
      };
    }

    if (scenario === "needs_input" && req.userGuidance.length === 0) {
      return {
        status: "completed",
        costCents,
        output: {
          summary: `${TAG} Paused for a product decision.`,
          artifacts: [],
          checks: [],
          proposedTasks: [],
          claimsComplete: false,
          needsInput: "Which audience should the copy target: developers or executives?",
        },
      };
    }

    const output = this.produceWork(req);
    if (scenario === "claims_done" && attempt === 1 && req.criterion) {
      // Claims success, but the deliverable is incomplete; the verifier must catch this.
      output.artifacts = output.artifacts.map((a) => ({ ...a, content: `${TAG} Draft placeholder for ${a.name}.` }));
      output.checks = output.checks.map((c) => ({ ...c, passed: false, detail: "1 test failing" }));
      output.summary = `${TAG} All done! (claimed)`;
      output.claimsComplete = true;
    }
    if (scenario === "needs_approval" && req.criterion?.position === 0 && attempt === 1) {
      // Deliberately mislabelled as routine work: the orchestrator must classify it and gate it.
      output.proposedTasks.push({
        title: "Deploy the release to production",
        description: "Promote the current build to the production environment.",
        actionKind: "write_code",
      });
    }
    return { status: "completed", output, costCents };
  }

  /** The simulation has no external side effects, so an interrupted dispatch is safe to redo. */
  async recover(): Promise<DispatchOutcome | null> {
    return null;
  }

  private produceWork(req: DispatchRequest): AgentOutput {
    const output: AgentOutput = {
      summary: `${TAG} Completed "${req.task.title}".`,
      artifacts: [],
      checks: [],
      proposedTasks: [],
      claimsComplete: false,
      needsInput: null,
    };
    const guidance = req.userGuidance.length ? `\n\nOwner guidance applied: ${req.userGuidance.join("; ")}` : "";
    const rule = req.criterion?.rule;
    if (!rule || rule.type === "manual" || rule.type === "github_file_contains" || rule.type === "github_checks_pass") {
      output.artifacts.push({
        kind: "file",
        name: `${slug(req.task.title)}.md`,
        content: `${TAG} Simulated deliverable for: ${req.task.title}${guidance}`,
      });
    } else if (rule.type === "artifact_exists") {
      output.artifacts.push({
        kind: "file",
        name: rule.artifact,
        content: `${TAG} Simulated ${rule.artifact} for "${req.project.name}".${guidance}`,
      });
    } else if (rule.type === "artifact_contains") {
      output.artifacts.push({
        kind: "file",
        name: rule.artifact,
        content: `${TAG} Simulated ${rule.artifact}\n\n## ${rule.text}\n\nPlaceholder section generated by the demo adapter.${guidance}`,
      });
    } else if (rule.type === "check_passed") {
      output.checks.push({ name: rule.check, passed: true, detail: `${TAG} 12 passed, 0 failed` });
    }
    return output;
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "deliverable"
  );
}
