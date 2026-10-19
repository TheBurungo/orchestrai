import { useState } from "react";
import {
  ACTION_KINDS,
  ALWAYS_GATED_ACTIONS,
  AUTONOMY_LEVELS,
  type ActionKind,
  type AcceptanceCriterion,
  type AutonomyLevel,
  type ProjectDetail,
  type ProjectLimits,
  type ProjectPolicy,
  type VerificationRule,
} from "../../shared/types.js";
import { api } from "./api.js";
import { AdapterBadge, AttentionCard, ConfigFieldInput, ErrorBanner, StatePill, money, relativeTime, useAction, usePolling } from "./common.js";
import { ProjectControls } from "./ProjectControls.js";

const TABS = ["Overview", "Tasks", "Activity", "Artifacts", "Attention", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function ProjectDetailView({ id }: { id: string }) {
  const { data, error, refresh } = usePolling(() => api.project(id), 2000, [id]);
  const [tab, setTab] = useState<Tab>("Overview");

  if (!data) return <div className="loading">{error ? <ErrorBanner error={error} /> : "Loading…"}</div>;
  const { project: p, adapter } = data;
  const pending = data.attention.filter((a) => a.status === "pending");
  const simulated = adapter ? !adapter.live : false;

  return (
    <div className="detail-page">
      <ErrorBanner error={error} />
      <header className="detail-header">
        <div>
          <a href="#/" className="muted small">
            ← All projects
          </a>
          <h1>{p.name}</h1>
          <div className="badges">
            <StatePill state={p.state} />
            <AdapterBadge simulated={simulated} live={adapter?.live} category={adapter?.category} />
            <span className="badge">{adapter?.name ?? p.adapter}</span>
            <span className="badge">{p.autonomy}</span>
          </div>
          {p.stateReason && <p className="muted">{p.stateReason}</p>}
        </div>
        <ProjectControls project={p} onChanged={() => void refresh()} />
      </header>

      {simulated && (
        <div className="notice demo">
          This project uses the <strong>demo adapter</strong>. All agent work, artifacts and checks shown here are simulated locally; no real agent or
          repository is involved.
        </div>
      )}

      <section className="kpis">
        <Kpi label="Criteria verified" value={`${data.criteria.filter((c) => c.status === "verified").length}/${data.criteria.length}`} />
        <Kpi label="Spent" value={`${money(p.spentCents)} of ${money(p.limits.budgetCents)}`} />
        <Kpi label="Steps" value={`${p.stepsTaken} of ${p.limits.maxSteps}`} />
        <Kpi label="Steps without progress" value={`${p.noProgressSteps} (limit ${p.limits.stallLimit})`} />
        <Kpi label="Last progress" value={relativeTime(p.lastProgressAt)} />
      </section>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t}
            {t === "Attention" && pending.length > 0 && <span className="count">{pending.length}</span>}
          </button>
        ))}
      </nav>

      {tab === "Overview" && <OverviewTab data={data} onChanged={() => void refresh()} />}
      {tab === "Tasks" && <TasksTab data={data} onChanged={() => void refresh()} />}
      {tab === "Activity" && <ActivityTab data={data} />}
      {tab === "Artifacts" && <ArtifactsTab data={data} />}
      {tab === "Attention" && <AttentionTab data={data} onChanged={() => void refresh()} />}
      {tab === "Settings" && <SettingsTab key={p.id} data={data} onChanged={() => void refresh()} />}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function describeRule(rule: VerificationRule): string {
  switch (rule.type) {
    case "artifact_exists":
      return `Artifact "${rule.artifact}" exists`;
    case "artifact_contains":
      return `Artifact "${rule.artifact}" contains "${rule.text}"`;
    case "check_passed":
      return `Check "${rule.check}" passed (executed, not self-reported)`;
    case "github_file_contains":
      return `GitHub file ${rule.path}${rule.ref ? `@${rule.ref}` : ""} contains "${rule.text}"`;
    case "github_checks_pass":
      return `All GitHub checks pass on ${rule.ref}`;
    case "manual":
      return "Confirmed by you";
  }
}

function OverviewTab({ data, onChanged }: { data: ProjectDetail; onChanged: () => void }) {
  const p = data.project;
  const pending = data.attention.filter((a) => a.status === "pending");
  return (
    <div className="tab-body grid-2">
      <section>
        <h3>Goal</h3>
        <p className="prewrap">{p.goal}</p>
        {p.constraints && (
          <>
            <h3>Constraints</h3>
            <p className="prewrap">{p.constraints}</p>
          </>
        )}
        <h3>Status</h3>
        <dl className="facts">
          <dt>Now</dt>
          <dd>{p.currentActivity ?? "—"}</dd>
          <dt>Last progress</dt>
          <dd>{p.lastProgressSummary ?? "None yet"}</dd>
          <dt>Next</dt>
          <dd>{p.nextAction ?? "—"}</dd>
          {p.nextRunAt && (
            <>
              <dt>Next attempt</dt>
              <dd>{relativeTime(p.nextRunAt)}</dd>
            </>
          )}
          {p.completedAt && (
            <>
              <dt>Completed</dt>
              <dd>{new Date(p.completedAt).toLocaleString()}</dd>
            </>
          )}
        </dl>
        {pending.length > 0 && (
          <>
            <h3>Needs you</h3>
            {pending.map((item) => (
              <AttentionCard key={item.id} item={item} onResolved={onChanged} />
            ))}
          </>
        )}
      </section>
      <section>
        <h3>Acceptance criteria &amp; completion evidence</h3>
        <p className="muted small">A project completes only when every criterion is verified by evidence. An agent claiming "done" is not enough.</p>
        <ol className="criteria">
          {data.criteria.map((c) => (
            <CriterionRow key={c.id} c={c} />
          ))}
        </ol>
        {data.adapter && (
          <>
            <h3>Integration: {data.adapter.name}</h3>
            <p className="small">{data.adapter.description}</p>
            {data.adapter.limitations.length > 0 && (
              <ul className="small limitations">
                {data.adapter.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function CriterionRow({ c }: { c: AcceptanceCriterion }) {
  const icon = c.status === "verified" ? "✔" : c.status === "failed" ? "✖" : "○";
  return (
    <li className={`criterion criterion-${c.status}`}>
      <span className="criterion-icon" aria-label={c.status}>
        {icon}
      </span>
      <div>
        <div>{c.description}</div>
        <div className="muted small">{describeRule(c.rule)}</div>
        {c.evidence && (
          <div className="evidence small">
            <strong>Evidence:</strong> {c.evidence} {c.verifiedAt && <span className="muted">({relativeTime(c.verifiedAt)})</span>}
          </div>
        )}
        {c.feedback && c.status !== "verified" && (
          <div className="feedback small">
            <strong>Not yet:</strong> {c.feedback}
          </div>
        )}
      </div>
    </li>
  );
}

function TasksTab({ data, onChanged }: { data: ProjectDetail; onChanged: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [actionKind, setActionKind] = useState<ActionKind>("write_code");
  const add = useAction(() => {
    setTitle("");
    setDescription("");
    onChanged();
  });
  const terminal = data.project.state === "completed" || data.project.state === "stopped";

  return (
    <div className="tab-body">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Task</th>
            <th>Action</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {data.tasks.map((t) => (
            <tr key={t.id}>
              <td>{t.position}</td>
              <td>
                <div>{t.title}</div>
                <div className="muted small">
                  {t.source}
                  {t.approvedAt && " · approved"}
                </div>
              </td>
              <td>
                <span className={`badge action-${t.actionKind}`}>{t.actionKind}</span>
              </td>
              <td>
                <span className={`pill task-${t.status}`}>{t.status.replace("_", " ")}</span>
              </td>
              <td>{t.attempts}</td>
              <td className="small">{t.lastError ? <span className="feedback">{t.lastError}</span> : t.resultSummary ?? ""}</td>
            </tr>
          ))}
          {data.tasks.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No tasks yet. The orchestrator plans tasks from unmet acceptance criteria when the project starts.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {!terminal && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add.run(() => api.addTask(data.project.id, { title, description, actionKind }));
          }}
        >
          <h3>Add a task</h3>
          <input aria-label="Task title" placeholder="Task title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <textarea aria-label="Task description" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          <label>
            Action kind{" "}
            <select value={actionKind} onChange={(e) => setActionKind(e.target.value as ActionKind)}>
              {ACTION_KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <p className="muted small">The orchestrator may classify the task as more consequential than declared (e.g. if the text mentions deploying).</p>
          <button type="submit" className="primary" disabled={add.busy || !title.trim()}>
            Add task
          </button>
          <ErrorBanner error={add.error} />
        </form>
      )}
    </div>
  );
}

function ActivityTab({ data }: { data: ProjectDetail }) {
  return (
    <div className="tab-body grid-2">
      <section>
        <h3>Activity &amp; audit log</h3>
        <ul className="timeline">
          {data.events.map((e) => (
            <li key={e.id} className={`event actor-${e.actor}`}>
              <span className="muted small" title={new Date(e.ts).toLocaleString()}>
                {relativeTime(e.ts)}
              </span>{" "}
              <span className="badge">{e.actor}</span> <span className="small mono">{e.type}</span>
              <div>{e.message}</div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Dispatches</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th>Cost</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {data.dispatches.map((d) => (
              <tr key={d.id}>
                <td className="small">{relativeTime(d.startedAt)}</td>
                <td>
                  <span className={`pill dispatch-${d.status}`}>{d.status.replace("_", " ")}</span>
                </td>
                <td>{money(d.costCents)}</td>
                <td className="small">
                  {d.error ? <span className="feedback">{d.error}</span> : d.summary}
                  {d.externalRef && <div className="muted mono">{safeLink(d.externalRef)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** Renders a link only for http(s) URLs; anything else is shown as text. */
function safeLink(ref: string) {
  try {
    const url = new URL(ref);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return (
        <a href={url.href} target="_blank" rel="noopener noreferrer">
          {ref}
        </a>
      );
    }
  } catch {
    // not a URL
  }
  return ref;
}

function ArtifactsTab({ data }: { data: ProjectDetail }) {
  if (data.artifacts.length === 0) return <p className="tab-body muted">No artifacts yet.</p>;
  return (
    <div className="tab-body artifacts">
      {data.artifacts.map((a) => (
        <details key={a.id} className="artifact">
          <summary>
            <span className="badge">{a.kind}</span> <strong>{a.name}</strong>{" "}
            {a.simulated && <span className="badge badge-demo">simulated</span>}{" "}
            <span className="muted small">
              from {a.source} · {relativeTime(a.createdAt)}
            </span>
          </summary>
          {a.kind === "link" ? <p>{safeLink(a.content)}</p> : <pre className="detail">{a.content}</pre>}
        </details>
      ))}
    </div>
  );
}

function AttentionTab({ data, onChanged }: { data: ProjectDetail; onChanged: () => void }) {
  const pending = data.attention.filter((a) => a.status === "pending");
  const history = data.attention.filter((a) => a.status !== "pending");
  return (
    <div className="tab-body">
      {pending.length === 0 && <p className="muted">Nothing pending.</p>}
      {pending.map((item) => (
        <AttentionCard key={item.id} item={item} onResolved={onChanged} />
      ))}
      {history.length > 0 && (
        <>
          <h3>History</h3>
          <ul className="timeline">
            {history.map((a) => (
              <li key={a.id}>
                <span className="badge">{a.kind}</span> {a.title} → <strong>{a.status}</strong>
                {a.resolution && <span className="muted"> – {a.resolution.slice(0, 200)}</span>}{" "}
                <span className="muted small">{relativeTime(a.resolvedAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SettingsTab({ data, onChanged }: { data: ProjectDetail; onChanged: () => void }) {
  const p = data.project;
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(p.autonomy);
  const [limits, setLimits] = useState<ProjectLimits>(p.limits);
  const [policy, setPolicy] = useState<ProjectPolicy>(p.policy);
  const [config, setConfig] = useState<Record<string, string>>(p.adapterConfig);
  const [guidance, setGuidance] = useState("");
  const save = useAction(onChanged);
  const guide = useAction(() => {
    setGuidance("");
    onChanged();
  });

  return (
    <div className="tab-body grid-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(() => api.updateSettings(p.id, { autonomy, limits, policy, adapterConfig: config }));
        }}
      >
        <h3>Autonomy &amp; limits</h3>
        <AutonomyField value={autonomy} onChange={setAutonomy} />
        <LimitsFields value={limits} onChange={setLimits} />
        <PolicyFields value={policy} onChange={setPolicy} />
        {data.adapter && data.adapter.configFields.length > 0 && (
          <fieldset>
            <legend>{data.adapter.name} settings</legend>
            {data.adapter.configFields.map((f) => (
              <ConfigFieldInput key={f.key} field={f} value={config[f.key] ?? ""} onChange={(v) => setConfig({ ...config, [f.key]: v })} />
            ))}
          </fieldset>
        )}
        <button type="submit" className="primary" disabled={save.busy}>
          Save settings
        </button>
        <ErrorBanner error={save.error} />
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void guide.run(() => api.addGuidance(p.id, guidance));
        }}
      >
        <h3>Add context or guidance</h3>
        <p className="muted small">
          Passed to the agent with every following task. Paste relevant context from ChatGPT, Claude or Lovable conversations here – those products cannot
          be read automatically.
        </p>
        <textarea rows={8} aria-label="Guidance" value={guidance} onChange={(e) => setGuidance(e.target.value)} />
        <button type="submit" className="primary" disabled={guide.busy || !guidance.trim()}>
          Add guidance
        </button>
        <ErrorBanner error={guide.error} />
        {p.context && (
          <>
            <h3>Initial context</h3>
            <pre className="detail">{p.context}</pre>
          </>
        )}
      </form>
    </div>
  );
}

export function AutonomyField({ value, onChange }: { value: AutonomyLevel; onChange: (v: AutonomyLevel) => void }) {
  const help: Record<AutonomyLevel, string> = {
    manual: "Approve every dispatch.",
    supervised: "Routine work continues automatically; periodic review checkpoints.",
    autonomous: "Routine work continues automatically. Gated actions still need approval.",
  };
  return (
    <fieldset>
      <legend>Autonomy</legend>
      {AUTONOMY_LEVELS.map((level) => (
        <label key={level} className="radio">
          <input type="radio" name="autonomy" checked={value === level} onChange={() => onChange(level)} />
          <strong>{level}</strong> <span className="muted small">{help[level]}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function LimitsFields({ value, onChange }: { value: ProjectLimits; onChange: (v: ProjectLimits) => void }) {
  const num = (key: keyof ProjectLimits, label: string, scale = 1, step = 1) => (
    <label>
      {label}
      <input
        type="number"
        min={0}
        step={step}
        value={value[key] / scale}
        onChange={(e) => onChange({ ...value, [key]: Math.round(Number(e.target.value) * scale) })}
      />
    </label>
  );
  return (
    <fieldset className="limits">
      <legend>Limits</legend>
      {num("budgetCents", "Budget (USD)", 100, 0.01)}
      {num("maxSteps", "Max agent turns")}
      {num("maxAttemptsPerTask", "Max attempts per task")}
      {num("stallLimit", "Turns without progress before escalating")}
    </fieldset>
  );
}

export function PolicyFields({ value, onChange }: { value: ProjectPolicy; onChange: (v: ProjectPolicy) => void }) {
  const mode = (k: ActionKind) => (value.deny.includes(k) ? "deny" : ALWAYS_GATED_ACTIONS.includes(k) || value.requireApproval.includes(k) ? "approve" : "auto");
  const set = (k: ActionKind, m: "auto" | "approve" | "deny") => {
    const requireApproval = value.requireApproval.filter((x) => x !== k);
    const deny = value.deny.filter((x) => x !== k);
    if (m === "approve" && !ALWAYS_GATED_ACTIONS.includes(k)) requireApproval.push(k);
    if (m === "deny") deny.push(k);
    onChange({ ...value, requireApproval, deny });
  };
  return (
    <fieldset>
      <legend>Authorization policy</legend>
      <table className="table policy">
        <tbody>
          {ACTION_KINDS.map((k) => (
            <tr key={k}>
              <td className="mono small">{k}</td>
              <td>
                <select aria-label={`Policy for ${k}`} value={mode(k)} onChange={(e) => set(k, e.target.value as "auto" | "approve" | "deny")}>
                  {!ALWAYS_GATED_ACTIONS.includes(k) && <option value="auto">Run automatically</option>}
                  <option value="approve">Require approval{ALWAYS_GATED_ACTIONS.includes(k) ? " (always)" : ""}</option>
                  <option value="deny">Never allow</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label>
        Review checkpoint every N turns (supervised mode, 0 = off)
        <input type="number" min={0} value={value.checkpointEvery} onChange={(e) => onChange({ ...value, checkpointEvery: Math.max(0, Math.round(Number(e.target.value))) })} />
      </label>
    </fieldset>
  );
}
