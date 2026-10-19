import type { Orchestrator } from "./orchestrator/engine.js";

/**
 * Background worker: repeatedly asks the orchestrator to step every due project.
 * Multiple workers (even in separate processes) are safe: each step holds a per-project lease in SQLite.
 */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = true;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly intervalMs: number,
    private readonly concurrency: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      if (!this.ticking) {
        this.ticking = true;
        try {
          await this.orchestrator.tick(this.concurrency);
        } catch (err) {
          console.error("[worker] tick failed:", (err as Error).message);
        } finally {
          this.ticking = false;
        }
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
