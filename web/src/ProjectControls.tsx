import type { Project } from "../../shared/types.js";
import { api } from "./api.js";
import { ErrorBanner, useAction } from "./common.js";

/** Start / pause / resume / stop controls, showing only the commands valid for the current state. */
export function ProjectControls({ project: p, onChanged, compact }: { project: Project; onChanged: () => void; compact?: boolean }) {
  const { busy, error, run } = useAction(onChanged);
  const cmd = (c: "start" | "pause" | "resume" | "stop") => void run(() => api.command(p.id, c));
  const stop = () => {
    if (window.confirm(`Stop "${p.name}"? In-flight work is abandoned and the project will not continue.`)) cmd("stop");
  };
  const terminal = p.state === "completed" || p.state === "stopped";

  return (
    <div className={`controls${compact ? " compact" : ""}`}>
      {p.state === "ready" && (
        <button type="button" className="primary" disabled={busy} onClick={() => cmd("start")}>
          Start
        </button>
      )}
      {(p.state === "working" || p.state === "ready" || p.state === "awaiting_approval" || p.state === "blocked") && (
        <button type="button" className="secondary" disabled={busy} onClick={() => cmd("pause")}>
          Pause
        </button>
      )}
      {(p.state === "paused" || p.state === "blocked" || p.state === "stopped") && (
        <button type="button" className="primary" disabled={busy} onClick={() => cmd("resume")} title={p.state === "blocked" ? "Retry blocked work" : undefined}>
          Resume
        </button>
      )}
      {!terminal && (
        <button type="button" className="danger" disabled={busy} onClick={stop}>
          Stop
        </button>
      )}
      <ErrorBanner error={error} />
    </div>
  );
}
