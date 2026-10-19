import { PROJECT_STATES, type ProjectState, type ProjectSummary } from "../../shared/types.js";
import { api } from "./api.js";
import { AdapterBadge, AttentionCard, ErrorBanner, STATE_LABELS, StatePill, money, relativeTime, useAction, usePolling } from "./common.js";
import { ProjectControls } from "./ProjectControls.js";

export function Dashboard() {
  const { data, error, refresh } = usePolling(api.overview);
  const seed = useAction(() => void refresh());

  if (!data) return <div className="loading">{error ? <ErrorBanner error={error} /> : "Loading…"}</div>;

  const counts = Object.fromEntries(PROJECT_STATES.map((s) => [s, 0])) as Record<ProjectState, number>;
  for (const p of data.projects) counts[p.state]++;

  return (
    <div className="dashboard">
      <ErrorBanner error={error} />
      {!data.worker.enabled && (
        <div className="notice">
          The background worker is disabled in this server process (WORKER_ENABLED=false). Run <code>npm run worker</code> so projects keep moving.
        </div>
      )}

      <section className="state-summary" aria-label="Projects by state">
        {PROJECT_STATES.map((s) => (
          <div key={s} className={`stat state-${s}`}>
            <strong>{counts[s]}</strong>
            <span>{STATE_LABELS[s]}</span>
          </div>
        ))}
      </section>

      <div className="columns">
        <section className="attention-queue" aria-labelledby="attention-heading">
          <h2 id="attention-heading">
            Needs you <span className="count">{data.attention.length}</span>
          </h2>
          {data.attention.length === 0 ? (
            <p className="muted empty">Nothing needs your attention. Projects continue within their policies and limits.</p>
          ) : (
            data.attention.map((item) => <AttentionCard key={item.id} item={item} showProject onResolved={() => void refresh()} />)
          )}
        </section>

        <section className="projects" aria-labelledby="projects-heading">
          <h2 id="projects-heading">Projects</h2>
          {data.projects.length === 0 && (
            <div className="empty-state">
              <p>No projects yet.</p>
              <p>
                <a href="#/new" className="button primary">
                  Create a project
                </a>{" "}
                or{" "}
                <button type="button" className="secondary" disabled={seed.busy} onClick={() => void seed.run(api.seedDemo)}>
                  Load demo projects
                </button>
              </p>
              <p className="muted small">Demo projects use the simulated demo adapter. No real agent does any work.</p>
              <ErrorBanner error={seed.error} />
            </div>
          )}
          <div className="project-grid">
            {data.projects.map((p) => (
              <ProjectCard key={p.id} project={p} onChanged={() => void refresh()} />
            ))}
          </div>
          {data.projects.length > 0 && !data.projects.some((p) => p.simulated) && (
            <p className="muted small">
              <button type="button" className="link" disabled={seed.busy} onClick={() => void seed.run(api.seedDemo)}>
                Load demo projects
              </button>{" "}
              to explore the workflow with simulated agents.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function ProjectCard({ project: p, onChanged }: { project: ProjectSummary; onChanged: () => void }) {
  return (
    <article className={`card project-card state-border-${p.state}`}>
      <header>
        <a href={`#/projects/${p.id}`} className="project-name">
          {p.name}
        </a>
        <StatePill state={p.state} />
      </header>
      <div className="badges">
        <AdapterBadge simulated={p.simulated} category={p.adapter === "manual" ? "manual_handoff" : undefined} />
        <span className="badge">{p.autonomy}</span>
        {p.pendingAttention > 0 && <span className="badge badge-attention">{p.pendingAttention} need you</span>}
      </div>
      <p className="goal">{p.goal}</p>
      <dl className="facts">
        <dt>Now</dt>
        <dd>{p.currentActivity ?? p.stateReason ?? "—"}</dd>
        <dt>Last progress</dt>
        <dd>
          {p.lastProgressSummary ?? "None yet"} <span className="muted small">({relativeTime(p.lastProgressAt)})</span>
        </dd>
        <dt>Next</dt>
        <dd>{p.nextAction ?? "—"}</dd>
      </dl>
      <div className="meters">
        <Meter label="Criteria verified" value={p.criteriaVerified} max={p.criteriaTotal} text={`${p.criteriaVerified}/${p.criteriaTotal}`} />
        <Meter label="Budget" value={p.spentCents} max={p.limits.budgetCents} text={`${money(p.spentCents)} / ${money(p.limits.budgetCents)}`} />
        <Meter label="Steps" value={p.stepsTaken} max={p.limits.maxSteps} text={`${p.stepsTaken}/${p.limits.maxSteps}`} />
      </div>
      <ProjectControls project={p} onChanged={onChanged} compact />
    </article>
  );
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="meter">
      <div className="meter-label">
        <span>{label}</span>
        <span>{text}</span>
      </div>
      <div className="meter-track" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
