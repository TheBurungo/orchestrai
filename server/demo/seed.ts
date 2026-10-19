import { DEFAULT_LIMITS, DEFAULT_POLICY, type Project } from "../../shared/types.js";
import type { Orchestrator } from "../orchestrator/engine.js";
import type { NewProjectInput } from "../store.js";

type Seed = Omit<NewProjectInput, "policy" | "limits" | "adapter"> & {
  policy?: NewProjectInput["policy"];
  limits?: NewProjectInput["limits"];
  start: boolean;
};

const SEEDS: Seed[] = [
  {
    name: "[DEMO] Docs refresh",
    goal: "Bring the project documentation up to date with an install guide, a changelog and passing doc tests.",
    constraints: "Keep the existing tone. No production changes.",
    context: "",
    adapterConfig: { scenario: "happy" },
    autonomy: "autonomous",
    criteria: [
      { description: "README has an Installation section", rule: { type: "artifact_contains", artifact: "README.md", text: "Installation" } },
      { description: "A CHANGELOG exists", rule: { type: "artifact_exists", artifact: "CHANGELOG.md" } },
      { description: "Doc tests pass", rule: { type: "check_passed", check: "doc-tests" } },
    ],
    start: true,
  },
  {
    name: "[DEMO] Billing service release",
    goal: "Ship the retry fix for the billing webhook handler.",
    constraints: "Production deploys need sign-off.",
    context: "",
    adapterConfig: { scenario: "needs_approval" },
    autonomy: "supervised",
    criteria: [
      { description: "Fix implemented in webhook.ts", rule: { type: "artifact_contains", artifact: "webhook.ts", text: "retry" } },
      { description: "Billing tests pass", rule: { type: "check_passed", check: "billing-tests" } },
    ],
    start: true,
  },
  {
    name: "[DEMO] Landing page copy",
    goal: "Write landing page copy for the new analytics feature.",
    constraints: "Under 200 words.",
    context: "",
    adapterConfig: { scenario: "needs_input" },
    autonomy: "supervised",
    criteria: [
      { description: "Copy has a headline", rule: { type: "artifact_contains", artifact: "landing.md", text: "Headline" } },
      { description: "Owner approves the tone", rule: { type: "manual" } },
    ],
    start: true,
  },
  {
    name: "[DEMO] Flaky provider",
    goal: "Generate an API reference despite transient provider errors.",
    constraints: "",
    context: "",
    adapterConfig: { scenario: "flaky" },
    autonomy: "autonomous",
    criteria: [{ description: "API reference exists", rule: { type: "artifact_exists", artifact: "api-reference.md" } }],
    start: true,
  },
  {
    name: "[DEMO] Premature 'done'",
    goal: "Produce a migration guide; the agent claims success before it is actually finished.",
    constraints: "",
    context: "",
    adapterConfig: { scenario: "claims_done" },
    autonomy: "autonomous",
    criteria: [
      { description: "Migration guide covers rollback", rule: { type: "artifact_contains", artifact: "MIGRATION.md", text: "Rollback" } },
    ],
    start: true,
  },
  {
    name: "[DEMO] Stalled research",
    goal: "Summarise competitor pricing; the simulated agent keeps producing the same notes.",
    constraints: "",
    context: "",
    adapterConfig: { scenario: "stall" },
    autonomy: "autonomous",
    criteria: [{ description: "Pricing summary written", rule: { type: "artifact_exists", artifact: "pricing.md" } }],
    start: false,
  },
];

export function seedDemoProjects(orchestrator: Orchestrator): Project[] {
  return SEEDS.map((seed) => {
    const { start, ...rest } = seed;
    const project = orchestrator.store.createProject({
      ...rest,
      adapter: "demo",
      policy: seed.policy ?? DEFAULT_POLICY,
      limits: seed.limits ?? DEFAULT_LIMITS,
    });
    orchestrator.store.log(project.id, "user", "project_created", `Created demo project "${project.name}" (simulated adapter)`);
    return start ? orchestrator.start(project.id) : project;
  });
}
