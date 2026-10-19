import type { AcceptanceCriterion, Artifact, Project } from "../../shared/types.js";
import type { ProviderAdapter } from "../adapters/types.js";
import type { Store } from "../store.js";

export interface VerificationResult {
  criterion: AcceptanceCriterion;
  passed: boolean;
  evidence: string;
}

const latest = (artifacts: Artifact[], pred: (a: Artifact) => boolean) => artifacts.find(pred); // artifacts are newest-first

function describeArtifact(a: Artifact): string {
  return `artifact "${a.name}" (${a.id.slice(0, 8)}, from ${a.source}${a.simulated ? ", SIMULATED" : ""}, ${a.createdAt})`;
}

/**
 * Verify acceptance criteria from evidence only: stored artifacts, executed checks, or
 * provider-side facts (e.g. repository contents). An agent claiming it is done is never evidence.
 * Manual criteria are confirmed by the user through the attention queue, not here.
 */
export async function verifyCriteria(
  store: Store,
  adapter: ProviderAdapter | undefined,
  project: Project,
  signal: AbortSignal,
): Promise<VerificationResult[]> {
  const artifacts = store.listArtifacts(project.id);
  const results: VerificationResult[] = [];
  for (const criterion of store.listCriteria(project.id)) {
    if (criterion.status === "verified" || criterion.rule.type === "manual") continue;
    const rule = criterion.rule;
    let passed = false;
    let evidence = "";
    switch (rule.type) {
      case "artifact_exists": {
        const a = latest(artifacts, (x) => x.name === rule.artifact && x.kind !== "check" && x.kind !== "user_input");
        passed = !!a;
        evidence = a ? `Found ${describeArtifact(a)}` : `No artifact named "${rule.artifact}" yet`;
        break;
      }
      case "artifact_contains": {
        const a = latest(artifacts, (x) => x.name === rule.artifact && x.kind !== "check" && x.kind !== "user_input");
        passed = !!a && a.content.toLowerCase().includes(rule.text.toLowerCase());
        evidence = !a
          ? `No artifact named "${rule.artifact}" yet`
          : passed
            ? `${describeArtifact(a)} contains "${rule.text}"`
            : `Latest "${rule.artifact}" does not contain "${rule.text}"`;
        break;
      }
      case "check_passed": {
        const a = latest(artifacts, (x) => x.kind === "check" && x.name === rule.check);
        passed = !!a && a.content.startsWith("PASSED");
        evidence = !a ? `Check "${rule.check}" has not run yet` : `Check ${describeArtifact(a)}: ${a.content}`;
        break;
      }
      case "github_file_contains":
      case "github_checks_pass": {
        if (!adapter?.checkRule) {
          evidence = "The project's adapter cannot evaluate this rule";
          break;
        }
        try {
          const r = await adapter.checkRule(rule, project.adapterConfig, signal);
          if (r) {
            passed = r.passed;
            evidence = r.evidence;
          } else {
            evidence = "Rule could not be evaluated (adapter not configured)";
          }
        } catch (err) {
          evidence = `Verification error: ${(err as Error).message}`;
        }
        break;
      }
    }
    if (passed) {
      store.updateCriterion(criterion.id, { status: "verified", evidence, feedback: null });
    } else {
      store.updateCriterion(criterion.id, { status: "pending", feedback: evidence });
    }
    results.push({ criterion, passed, evidence });
  }
  return results;
}
