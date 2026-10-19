import { useCallback, useEffect, useRef, useState } from "react";
import type { AdapterConfigField, AttentionAction, AttentionItem, ProjectState } from "../../shared/types.js";
import { api } from "./api.js";

export const STATE_LABELS: Record<ProjectState, string> = {
  ready: "Ready to continue",
  working: "Working",
  awaiting_approval: "Awaiting approval",
  blocked: "Blocked",
  paused: "Paused",
  completed: "Completed",
  stopped: "Stopped",
};

export function navigate(path: string) {
  window.location.hash = path;
}

/** Polls `load` every `intervalMs` while the tab is visible. */
export function usePolling<T>(load: () => Promise<T>, intervalMs = 2000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    setData(null);
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, intervalMs, ...deps]);

  return { data, error, refresh };
}

/** Runs an async action, tracking busy state and surfacing errors. */
export function useAction(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        onDone?.();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onDone],
  );
  return { busy, error, run, setError };
}

export function StatePill({ state }: { state: ProjectState }) {
  return <span className={`pill state-${state}`}>{STATE_LABELS[state]}</span>;
}

export function AdapterBadge({ simulated, live, category }: { simulated: boolean; live?: boolean; category?: string }) {
  if (simulated || live === false) return <span className="badge badge-demo" title="Simulated work from the demo adapter – not a real agent">DEMO · simulated</span>;
  if (category === "manual_handoff") return <span className="badge badge-manual" title="You relay prompts and replies manually">MANUAL handoff</span>;
  return <span className="badge badge-live">LIVE</span>;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  let text: string;
  if (abs < 45_000) text = "moments";
  else if (abs < 3_600_000) text = fmt(Math.round(abs / 60_000), "minute");
  else if (abs < 86_400_000) text = fmt(Math.round(abs / 3_600_000), "hour");
  else text = fmt(Math.round(abs / 86_400_000), "day");
  if (text === "moments") return diff >= 0 ? "just now" : "in a moment";
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {error}
    </div>
  );
}

const ACTION_LABELS: Record<AttentionItem["kind"], Partial<Record<AttentionAction, string>>> = {
  approval: { approve: "Approve", reject: "Reject" },
  budget: { approve: "Raise budget & continue", reject: "Decline & pause" },
  checkpoint: { approve: "Looks good – continue", reject: "Pause project" },
  handoff: { respond: "Submit response", reject: "Decline & pause" },
  blocker: { respond: "Send guidance & retry", reject: "Stop project" },
  verification: { approve: "Confirm met", reject: "Not met yet" },
  uncertain_dispatch: { approve: "It did not run – retry", reject: "Pause so I can check" },
};

const KIND_LABELS: Record<AttentionItem["kind"], string> = {
  approval: "Approval",
  budget: "Budget",
  checkpoint: "Checkpoint",
  handoff: "Manual handoff",
  blocker: "Blocker",
  verification: "Verify",
  uncertain_dispatch: "Uncertain dispatch",
};

/** A single decision that needs the user, with inline resolution controls. */
export function AttentionCard({ item, showProject, onResolved }: { item: AttentionItem; showProject?: boolean; onResolved: () => void }) {
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction(onResolved);
  const needsText = item.actions.includes("respond");
  const isHandoff = item.kind === "handoff";

  return (
    <article className={`attention attention-${item.kind}`}>
      <header>
        <span className="pill kind">{KIND_LABELS[item.kind]}</span>
        {showProject && item.projectName && (
          <a className="project-link" href={`#/projects/${item.projectId}`}>
            {item.projectName}
          </a>
        )}
        <span className="muted small">{relativeTime(item.createdAt)}</span>
      </header>
      <h4>{item.title}</h4>
      {item.detail && (
        <details open={!isHandoff || !showProject}>
          <summary>{isHandoff ? "Prompt to copy into the AI tool" : "Details"}</summary>
          <pre className="detail">{item.detail}</pre>
          {isHandoff && (
            <button type="button" className="secondary small" onClick={() => void navigator.clipboard?.writeText(item.detail)}>
              Copy prompt
            </button>
          )}
        </details>
      )}
      {(needsText || item.kind === "approval" || item.kind === "verification") && (
        <textarea
          aria-label="Response or note"
          placeholder={
            isHandoff ? "Paste the AI tool's reply here (plain text or the JSON format requested)" : needsText ? "Guidance for the agent" : "Optional note"
          }
          rows={isHandoff ? 6 : 2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className="actions">
        {item.actions.map((action) => (
          <button
            key={action}
            type="button"
            className={action === "reject" ? "secondary" : "primary"}
            disabled={busy || (action === "respond" && !note.trim())}
            onClick={() => void run(() => api.resolve(item.id, action, note.trim() || null))}
          >
            {ACTION_LABELS[item.kind][action] ?? action}
          </button>
        ))}
      </div>
      <ErrorBanner error={error} />
    </article>
  );
}

export function ConfigFieldInput({ field, value, onChange }: { field: AdapterConfigField; value: string; onChange: (v: string) => void }) {
  return (
    <label>
      {field.label}
      {field.required && " *"}
      {field.options ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} required={field.required}>
          {!field.required && <option value="">(default)</option>}
          {field.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} required={field.required} />
      )}
      {field.help && <span className="muted small">{field.help}</span>}
    </label>
  );
}
