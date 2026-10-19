import type { AdapterInfo, VerificationRule } from "../../shared/types.js";
import { buildTaskPrompt } from "./output.js";
import { ProviderHttpError, providerFetch, type FetchLike } from "./modelApi.js";
import type { DispatchOutcome, DispatchRef, DispatchRequest, ProviderAdapter, RuleCheckResult } from "./types.js";

const API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LABEL = "orchestrai";

export interface GitHubAdapterOptions {
  token: string | undefined;
  pollIntervalMs: number;
  fetchImpl?: FetchLike;
}

const marker = (key: string) => `<!-- orchestrai-dispatch:${key} -->`;

/**
 * Dispatches work to GitHub as issues (optionally assigned to a user or coding agent you have enabled)
 * and gathers evidence from the repository itself: file contents and CI check runs.
 * Uses only the documented REST API with a token you provide.
 */
export class GitHubAdapter implements ProviderAdapter {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: GitHubAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  describe(): AdapterInfo {
    return {
      id: "github",
      name: "GitHub (issues + repository evidence)",
      category: "code_agent",
      live: true,
      configured: !!this.options.token,
      configurationHint: this.options.token ? null : "Set GITHUB_TOKEN in the server environment (.env).",
      description:
        "Creates a GitHub issue per task (optionally assigned to a person or to a coding agent enabled on the repository), polls it, and verifies acceptance criteria against repository files and CI check runs.",
      capabilities: [
        "Create and track issues via the REST API (idempotent: issues carry a dispatch marker)",
        "Verify criteria by reading files on a branch and by CI check-run conclusions",
        "Recover after restarts without creating duplicate issues",
      ],
      limitations: [
        "Whether an assignee (e.g. a coding agent) acts on the issue depends on your GitHub plan and repository settings",
        "A closed issue is not treated as success; only repository evidence verifies criteria",
        "Agent compute/premium-request usage is billed by GitHub and is not tracked in the project budget",
      ],
      configFields: [
        { key: "repo", label: "Repository (owner/name)", required: true, placeholder: "octo-org/my-app" },
        {
          key: "assignee",
          label: "Assignee (optional)",
          required: false,
          placeholder: "github-username",
          help: "A user or coding agent that can be assigned issues in this repository.",
        },
      ],
      verificationRules: ["github_file_contains", "github_checks_pass"],
      trustedChecks: false,
    };
  }

  validateConfig(config: Record<string, string>): string[] {
    const errors: string[] = [];
    if (!config.repo || !REPO_RE.test(config.repo)) errors.push("repo must look like owner/name");
    if (config.assignee && !/^[A-Za-z0-9-[\]]{1,60}$/.test(config.assignee)) errors.push("assignee is not a valid GitHub login");
    return errors;
  }

  estimateCostCents(): number {
    return 0;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "orchestrai",
      authorization: ["Bearer", this.options.token ?? ""].join(" "),
      "content-type": "application/json",
    };
  }

  private request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
    return providerFetch(this.fetchImpl, `${API}${path}`, { ...init, signal, headers: this.headers() }, "GitHub");
  }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    if (!this.options.token) return { status: "failed", error: "GITHUB_TOKEN is not configured on the server", retryable: false };
    const repo = req.config.repo;
    const body = [
      buildTaskPrompt(req),
      "",
      "---",
      "_Created by OrchestrAI. Acceptance is verified from repository evidence, not from this issue being closed._",
      marker(req.idempotencyKey),
    ].join("\n");
    try {
      const issue = (await this.request(`/repos/${repo}/issues`, req.signal, {
        method: "POST",
        body: JSON.stringify({
          title: `[orchestrai] ${req.task.title}`.slice(0, 250),
          body,
          labels: [LABEL],
          ...(req.config.assignee ? { assignees: [req.config.assignee] } : {}),
        }),
      })) as { number: number; html_url: string };
      return {
        status: "pending",
        externalRef: String(issue.number),
        pollAfterMs: this.options.pollIntervalMs,
        summary: `Waiting on GitHub issue #${issue.number}`,
      };
    } catch (err) {
      return this.failure(err);
    }
  }

  async poll(ref: DispatchRef): Promise<DispatchOutcome> {
    const repo = ref.config.repo;
    try {
      const issue = (await this.request(`/repos/${repo}/issues/${encodeURIComponent(ref.externalRef ?? "")}`, ref.signal)) as {
        number: number;
        state: string;
        state_reason?: string | null;
        html_url: string;
        title: string;
      };
      if (issue.state === "open") {
        return {
          status: "pending",
          externalRef: String(issue.number),
          pollAfterMs: this.options.pollIntervalMs,
          summary: `Waiting on GitHub issue #${issue.number}`,
        };
      }
      if (issue.state_reason === "not_planned") {
        return { status: "failed", error: `GitHub issue #${issue.number} was closed as not planned`, retryable: false };
      }
      return {
        status: "completed",
        costCents: 0,
        externalRef: String(issue.number),
        output: {
          summary: `GitHub issue #${issue.number} was closed. Verifying against repository evidence.`,
          artifacts: [{ kind: "link", name: `Issue #${issue.number}`, content: issue.html_url }],
          checks: [],
          proposedTasks: [],
          claimsComplete: true,
          needsInput: null,
        },
      };
    } catch (err) {
      return this.failure(err);
    }
  }

  /** Look for an issue carrying this dispatch's marker so a crash never produces a duplicate issue. */
  async recover(ref: DispatchRef): Promise<DispatchOutcome | null> {
    const issues = (await this.request(
      `/repos/${ref.config.repo}/issues?labels=${LABEL}&state=all&sort=created&direction=desc&per_page=100`,
      ref.signal,
    )) as Array<{ number: number; body?: string | null }>;
    const found = issues.find((i) => (i.body ?? "").includes(marker(ref.idempotencyKey)));
    if (!found) return null;
    return this.poll({ ...ref, externalRef: String(found.number) });
  }

  async checkRule(rule: VerificationRule, config: Record<string, string>, signal: AbortSignal): Promise<RuleCheckResult | null> {
    if (!this.options.token || !config.repo) return null;
    const repo = config.repo;
    if (rule.type === "github_file_contains") {
      if (rule.path.split("/").some((seg) => seg === ".." || seg === "")) {
        return { passed: false, evidence: `Invalid path ${rule.path}` };
      }
      const path = rule.path.split("/").map(encodeURIComponent).join("/");
      const query = rule.ref ? `?ref=${encodeURIComponent(rule.ref)}` : "";
      try {
        const file = (await this.request(`/repos/${repo}/contents/${path}${query}`, signal)) as {
          content?: string;
          encoding?: string;
          html_url?: string;
        };
        const text = file.encoding === "base64" ? Buffer.from(file.content ?? "", "base64").toString("utf8") : (file.content ?? "");
        const passed = text.includes(rule.text);
        return {
          passed,
          evidence: passed
            ? `${repo}/${rule.path}${rule.ref ? `@${rule.ref}` : ""} contains "${rule.text}" (${file.html_url ?? "GitHub"})`
            : `${repo}/${rule.path} does not contain "${rule.text}" yet`,
        };
      } catch (err) {
        if (err instanceof ProviderHttpError && /HTTP 404/.test(err.message)) {
          return { passed: false, evidence: `${repo}/${rule.path} does not exist yet` };
        }
        throw err;
      }
    }
    if (rule.type === "github_checks_pass") {
      const runs = (await this.request(
        `/repos/${repo}/commits/${encodeURIComponent(rule.ref)}/check-runs?per_page=100`,
        signal,
      )) as { total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null }> };
      if (!runs.total_count) return { passed: false, evidence: `No check runs found on ${rule.ref}` };
      const ok = new Set(["success", "neutral", "skipped"]);
      const bad = runs.check_runs.filter((r) => r.status !== "completed" || !ok.has(r.conclusion ?? ""));
      return bad.length
        ? { passed: false, evidence: `${bad.length} check(s) not passing on ${rule.ref}: ${bad.map((b) => `${b.name}=${b.conclusion ?? b.status}`).join(", ")}` }
        : { passed: true, evidence: `All ${runs.total_count} check runs passed on ${repo}@${rule.ref}` };
    }
    return null;
  }

  private failure(err: unknown): DispatchOutcome {
    if (err instanceof ProviderHttpError) {
      return { status: "failed", error: err.message, retryable: err.retryable, retryAfterMs: err.retryAfterMs };
    }
    return { status: "failed", error: (err as Error).message, retryable: true };
  }
}
