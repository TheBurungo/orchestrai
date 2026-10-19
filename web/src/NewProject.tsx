import { useEffect, useMemo, useState } from "react";
import { DEFAULT_LIMITS, DEFAULT_POLICY, type AutonomyLevel, type ProjectLimits, type ProjectPolicy, type VerificationRule } from "../../shared/types.js";
import { api, type AdapterListing } from "./api.js";
import { AdapterBadge, ConfigFieldInput, ErrorBanner, navigate, useAction } from "./common.js";
import { AutonomyField, LimitsFields, PolicyFields } from "./ProjectDetail.js";

type RuleType = VerificationRule["type"];

interface DraftCriterion {
  description: string;
  type: RuleType;
  artifact: string;
  text: string;
  check: string;
  path: string;
  ref: string;
}

const RULE_LABELS: Record<RuleType, string> = {
  artifact_exists: "Artifact exists",
  artifact_contains: "Artifact contains text",
  check_passed: "Executed check passed",
  github_file_contains: "GitHub file contains text",
  github_checks_pass: "GitHub checks pass on ref",
  manual: "I confirm it myself",
};

const emptyCriterion = (type: RuleType = "manual"): DraftCriterion => ({ description: "", type, artifact: "", text: "", check: "", path: "", ref: "" });

function toRule(c: DraftCriterion): VerificationRule {
  switch (c.type) {
    case "artifact_exists":
      return { type: c.type, artifact: c.artifact.trim() };
    case "artifact_contains":
      return { type: c.type, artifact: c.artifact.trim(), text: c.text };
    case "check_passed":
      return { type: c.type, check: c.check.trim() };
    case "github_file_contains":
      return { type: c.type, path: c.path.trim(), text: c.text, ...(c.ref.trim() ? { ref: c.ref.trim() } : {}) };
    case "github_checks_pass":
      return { type: c.type, ref: c.ref.trim() };
    case "manual":
      return { type: "manual" };
  }
}

export function NewProject() {
  const [adapters, setAdapters] = useState<AdapterListing[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [context, setContext] = useState("");
  const [adapterId, setAdapterId] = useState("demo");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("supervised");
  const [policy, setPolicy] = useState<ProjectPolicy>(DEFAULT_POLICY);
  const [limits, setLimits] = useState<ProjectLimits>(DEFAULT_LIMITS);
  const [criteria, setCriteria] = useState<DraftCriterion[]>([emptyCriterion()]);
  const [start, setStart] = useState(true);
  const submit = useAction();

  useEffect(() => {
    api.adapters().then(setAdapters, (err: Error) => setLoadError(err.message));
  }, []);

  const adapter = useMemo(() => adapters?.find((a) => a.id === adapterId) ?? null, [adapters, adapterId]);
  const supported = adapter?.supportedRules ?? ["manual"];

  const chooseAdapter = (id: string) => {
    setAdapterId(id);
    setConfig({});
    const rules = adapters?.find((a) => a.id === id)?.supportedRules ?? ["manual"];
    setCriteria((cs) => cs.map((c) => (rules.includes(c.type) ? c : { ...c, type: "manual" })));
  };

  const updateCriterion = (i: number, patch: Partial<DraftCriterion>) => setCriteria((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let createdId: string | null = null;
    const ok = await submit.run(async () => {
      const project = await api.createProject({
        name,
        goal,
        constraints,
        context,
        adapter: adapterId,
        adapterConfig: Object.fromEntries(Object.entries(config).filter(([, v]) => v.trim() !== "")),
        autonomy,
        policy,
        limits,
        criteria: criteria.map((c) => ({ description: c.description, rule: toRule(c) })),
        start,
      });
      createdId = project.id;
    });
    if (ok && createdId) navigate(`/projects/${createdId}`);
  };

  if (loadError) return <ErrorBanner error={loadError} />;
  if (!adapters) return <div className="loading">Loading…</div>;

  return (
    <form className="new-project" onSubmit={(e) => void onSubmit(e)}>
      <h1>New project</h1>

      <section className="card">
        <h3>Goal</h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label>
          Goal
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} required rows={3} placeholder="What does done look like?" />
        </label>
        <label>
          Constraints
          <textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} rows={2} placeholder="e.g. Don't change the public API. Use TypeScript." />
        </label>
        <label>
          Context
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={4}
            placeholder="Paste relevant background, e.g. a summary of an existing ChatGPT, Claude or Lovable conversation."
          />
        </label>
      </section>

      <section className="card">
        <h3>Agent integration</h3>
        <div className="adapter-choices">
          {adapters.map((a) => (
            <label key={a.id} className={`adapter-choice${a.id === adapterId ? " selected" : ""}${a.configured ? "" : " unconfigured"}`}>
              <input type="radio" name="adapter" checked={a.id === adapterId} onChange={() => chooseAdapter(a.id)} disabled={!a.configured} />
              <div>
                <strong>{a.name}</strong> <AdapterBadge simulated={!a.live} live={a.live} category={a.category} />
                <div className="small">{a.description}</div>
                {!a.configured && <div className="small feedback">Not configured: {a.configurationHint}</div>}
              </div>
            </label>
          ))}
        </div>
        {adapter && (
          <div className="adapter-info grid-2">
            <div>
              <h4>Can do</h4>
              <ul className="small">
                {adapter.capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4>Limitations</h4>
              <ul className="small limitations">
                {adapter.limitations.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {adapter?.configFields.map((f) => (
          <ConfigFieldInput key={f.key} field={f} value={config[f.key] ?? ""} onChange={(v) => setConfig({ ...config, [f.key]: v })} />
        ))}
      </section>

      <section className="card">
        <h3>Acceptance criteria</h3>
        <p className="muted small">
          The project is complete only when every criterion is verified by evidence. Only rule types this integration can produce evidence for are offered.
        </p>
        {criteria.map((c, i) => (
          <div key={i} className="criterion-editor">
            <input
              aria-label={`Criterion ${i + 1} description`}
              placeholder="Criterion, e.g. README documents installation"
              value={c.description}
              onChange={(e) => updateCriterion(i, { description: e.target.value })}
              required
            />
            <select aria-label={`Criterion ${i + 1} verification`} value={c.type} onChange={(e) => updateCriterion(i, { type: e.target.value as RuleType })}>
              {supported.map((t) => (
                <option key={t} value={t}>
                  {RULE_LABELS[t]}
                </option>
              ))}
            </select>
            {(c.type === "artifact_exists" || c.type === "artifact_contains") && (
              <input placeholder="Artifact name, e.g. README.md" value={c.artifact} onChange={(e) => updateCriterion(i, { artifact: e.target.value })} required />
            )}
            {c.type === "github_file_contains" && (
              <input placeholder="Path, e.g. README.md" value={c.path} onChange={(e) => updateCriterion(i, { path: e.target.value })} required />
            )}
            {(c.type === "artifact_contains" || c.type === "github_file_contains") && (
              <input placeholder="Required text" value={c.text} onChange={(e) => updateCriterion(i, { text: e.target.value })} required />
            )}
            {c.type === "check_passed" && (
              <input placeholder="Check name, e.g. unit-tests" value={c.check} onChange={(e) => updateCriterion(i, { check: e.target.value })} required />
            )}
            {(c.type === "github_checks_pass" || c.type === "github_file_contains") && (
              <input
                placeholder={c.type === "github_checks_pass" ? "Branch or SHA" : "Branch (optional)"}
                value={c.ref}
                onChange={(e) => updateCriterion(i, { ref: e.target.value })}
                required={c.type === "github_checks_pass"}
              />
            )}
            {criteria.length > 1 && (
              <button type="button" className="secondary small" onClick={() => setCriteria((cs) => cs.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => setCriteria((cs) => [...cs, emptyCriterion()])}>
          Add criterion
        </button>
      </section>

      <section className="card grid-2">
        <div>
          <AutonomyField value={autonomy} onChange={setAutonomy} />
          <LimitsFields value={limits} onChange={setLimits} />
        </div>
        <PolicyFields value={policy} onChange={setPolicy} />
      </section>

      <div className="submit-row">
        <label className="radio">
          <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start immediately
        </label>
        <button type="submit" className="primary" disabled={submit.busy}>
          Create project
        </button>
      </div>
      <ErrorBanner error={submit.error} />
    </form>
  );
}
