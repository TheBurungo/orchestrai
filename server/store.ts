import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AcceptanceCriterion,
  ActionKind,
  ActivityEvent,
  Artifact,
  ArtifactKind,
  AttentionAction,
  AttentionItem,
  AttentionKind,
  AttentionStatus,
  AutonomyLevel,
  Dispatch,
  DispatchStatus,
  Project,
  ProjectLimits,
  ProjectPolicy,
  ProjectState,
  ProjectSummary,
  Task,
  TaskSource,
  TaskStatus,
  VerificationRule,
} from "../shared/types.js";
import { redact, redactDeep } from "./security/redact.js";

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  constraints TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  adapter TEXT NOT NULL,
  adapter_config TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  state_reason TEXT,
  autonomy TEXT NOT NULL,
  policy TEXT NOT NULL,
  limits TEXT NOT NULL,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  steps_taken INTEGER NOT NULL DEFAULT 0,
  steps_since_checkpoint INTEGER NOT NULL DEFAULT 0,
  no_progress_steps INTEGER NOT NULL DEFAULT 0,
  current_activity TEXT,
  next_action TEXT,
  last_progress_at TEXT,
  last_progress_summary TEXT,
  next_run_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS criteria (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  rule TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  evidence TEXT,
  feedback TEXT,
  verified_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  action_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  criterion_id TEXT REFERENCES criteria(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  result_summary TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL,
  status TEXT NOT NULL,
  external_ref TEXT,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
-- At most one open dispatch per project: prevents concurrent conflicting actions.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_dispatch_per_project
  ON dispatches(project_id) WHERE status IN ('in_flight', 'awaiting_handoff');

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  dispatch_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_by_project ON artifacts(project_id, created_at);

CREATE TABLE IF NOT EXISTS attention_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  dispatch_id TEXT,
  criterion_id TEXT,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  actions TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
-- Never ask the user the same open question twice.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_attention_per_key
  ON attention_items(project_id, dedupe_key) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_by_project ON events(project_id, id);
`;

type Row = Record<string, SQLInputValue>;

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);

export const hashContent = (content: string): string => createHash("sha256").update(content).digest("hex");

/** Fingerprint of an artifact as stored (after redaction); used for duplicate/no-progress detection. */
export const artifactHash = (kind: ArtifactKind, name: string, content: string): string =>
  hashContent(`${kind}\u0000${redact(name)}\u0000${redact(content)}`);

function mapProject(r: Row): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    goal: String(r.goal),
    constraints: String(r.constraints),
    context: String(r.context),
    adapter: String(r.adapter),
    adapterConfig: json(r.adapter_config, {}),
    state: r.state as ProjectState,
    stateReason: str(r.state_reason),
    autonomy: r.autonomy as AutonomyLevel,
    policy: json<ProjectPolicy>(r.policy, { requireApproval: [], deny: [], checkpointEvery: 0 }),
    limits: json<ProjectLimits>(r.limits, { budgetCents: 0, maxSteps: 0, maxAttemptsPerTask: 1, stallLimit: 1 }),
    spentCents: num(r.spent_cents),
    stepsTaken: num(r.steps_taken),
    stepsSinceCheckpoint: num(r.steps_since_checkpoint),
    noProgressSteps: num(r.no_progress_steps),
    currentActivity: str(r.current_activity),
    nextAction: str(r.next_action),
    lastProgressAt: str(r.last_progress_at),
    lastProgressSummary: str(r.last_progress_summary),
    nextRunAt: str(r.next_run_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: str(r.completed_at),
  };
}

function mapCriterion(r: Row): AcceptanceCriterion {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    position: num(r.position),
    description: String(r.description),
    rule: json<VerificationRule>(r.rule, { type: "manual" }),
    status: r.status as AcceptanceCriterion["status"],
    evidence: str(r.evidence),
    feedback: str(r.feedback),
    verifiedAt: str(r.verified_at),
  };
}

function mapTask(r: Row): Task {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    position: num(r.position),
    title: String(r.title),
    description: String(r.description),
    actionKind: r.action_kind as ActionKind,
    status: r.status as TaskStatus,
    source: r.source as TaskSource,
    criterionId: str(r.criterion_id),
    attempts: num(r.attempts),
    approvedAt: str(r.approved_at),
    resultSummary: str(r.result_summary),
    lastError: str(r.last_error),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapDispatch(r: Row): Dispatch {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    taskId: String(r.task_id),
    idempotencyKey: String(r.idempotency_key),
    adapter: String(r.adapter),
    status: r.status as DispatchStatus,
    externalRef: str(r.external_ref),
    costCents: num(r.cost_cents),
    summary: str(r.summary),
    error: str(r.error),
    startedAt: String(r.started_at),
    finishedAt: str(r.finished_at),
  };
}

function mapArtifact(r: Row): Artifact {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    taskId: str(r.task_id),
    dispatchId: str(r.dispatch_id),
    kind: r.kind as ArtifactKind,
    name: String(r.name),
    content: String(r.content),
    contentHash: String(r.content_hash),
    source: String(r.source),
    simulated: num(r.simulated) === 1,
    createdAt: String(r.created_at),
  };
}

function mapAttention(r: Row): AttentionItem {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    projectName: r.project_name === undefined ? undefined : String(r.project_name),
    taskId: str(r.task_id),
    dispatchId: str(r.dispatch_id),
    criterionId: str(r.criterion_id),
    kind: r.kind as AttentionKind,
    title: String(r.title),
    detail: String(r.detail),
    actions: json<AttentionAction[]>(r.actions, []),
    status: r.status as AttentionStatus,
    resolution: str(r.resolution),
    createdAt: String(r.created_at),
    resolvedAt: str(r.resolved_at),
  };
}

function mapEvent(r: Row): ActivityEvent {
  return {
    id: num(r.id),
    projectId: str(r.project_id),
    ts: String(r.ts),
    actor: String(r.actor),
    type: String(r.type),
    message: String(r.message),
    data: json<Record<string, unknown> | null>(r.data, null),
  };
}

export interface NewProjectInput {
  name: string;
  goal: string;
  constraints: string;
  context: string;
  adapter: string;
  adapterConfig: Record<string, string>;
  autonomy: AutonomyLevel;
  policy: ProjectPolicy;
  limits: ProjectLimits;
  criteria: Array<{ description: string; rule: VerificationRule }>;
}

export type ProjectPatch = Partial<{
  state: ProjectState;
  stateReason: string | null;
  autonomy: AutonomyLevel;
  policy: ProjectPolicy;
  limits: ProjectLimits;
  adapterConfig: Record<string, string>;
  context: string;
  spentCents: number;
  stepsTaken: number;
  stepsSinceCheckpoint: number;
  noProgressSteps: number;
  currentActivity: string | null;
  nextAction: string | null;
  lastProgressAt: string | null;
  lastProgressSummary: string | null;
  nextRunAt: string | null;
  completedAt: string | null;
}>;

const PROJECT_COLUMNS: Record<keyof ProjectPatch, string> = {
  state: "state",
  stateReason: "state_reason",
  autonomy: "autonomy",
  policy: "policy",
  limits: "limits",
  adapterConfig: "adapter_config",
  context: "context",
  spentCents: "spent_cents",
  stepsTaken: "steps_taken",
  stepsSinceCheckpoint: "steps_since_checkpoint",
  noProgressSteps: "no_progress_steps",
  currentActivity: "current_activity",
  nextAction: "next_action",
  lastProgressAt: "last_progress_at",
  lastProgressSummary: "last_progress_summary",
  nextRunAt: "next_run_at",
  completedAt: "completed_at",
};

export class Store {
  readonly db: DatabaseSync;

  constructor(
    path: string,
    readonly clock: Clock = systemClock,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  now(): string {
    return this.clock().toISOString();
  }

  /** Run `fn` inside a write transaction. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  // ---------------------------------------------------------------- projects

  createProject(input: NewProjectInput): Project {
    const id = randomUUID();
    const now = this.now();
    this.tx(() => {
      this.run(
        `INSERT INTO projects (id, name, goal, constraints, context, adapter, adapter_config, state, autonomy, policy, limits,
           next_action, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)`,
        id,
        input.name,
        input.goal,
        input.constraints,
        input.context,
        input.adapter,
        JSON.stringify(input.adapterConfig),
        input.autonomy,
        JSON.stringify(input.policy),
        JSON.stringify(input.limits),
        "Start the project to begin orchestration",
        now,
        now,
      );
      input.criteria.forEach((c, i) => {
        this.run(
          `INSERT INTO criteria (id, project_id, position, description, rule) VALUES (?, ?, ?, ?, ?)`,
          randomUUID(),
          id,
          i,
          c.description,
          JSON.stringify(c.rule),
        );
      });
    });
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    const r = this.get(`SELECT * FROM projects WHERE id = ?`, id);
    return r ? mapProject(r) : null;
  }

  listProjects(): Project[] {
    return this.all(`SELECT * FROM projects ORDER BY created_at DESC`).map(mapProject);
  }

  listProjectSummaries(simulatedAdapters: Set<string>): ProjectSummary[] {
    return this.all(
      `SELECT p.*,
         (SELECT COUNT(*) FROM criteria c WHERE c.project_id = p.id) AS criteria_total,
         (SELECT COUNT(*) FROM criteria c WHERE c.project_id = p.id AND c.status = 'verified') AS criteria_verified,
         (SELECT COUNT(*) FROM attention_items a WHERE a.project_id = p.id AND a.status = 'pending') AS pending_attention
       FROM projects p ORDER BY p.created_at DESC`,
    ).map((r) => {
      const p = mapProject(r);
      return {
        ...p,
        criteriaTotal: num(r.criteria_total),
        criteriaVerified: num(r.criteria_verified),
        pendingAttention: num(r.pending_attention),
        simulated: simulatedAdapters.has(p.adapter),
      };
    });
  }

  /**
   * Update project fields. When `expectedStates` is given the update only applies if the project is
   * currently in one of those states (guards against races with user commands such as pause/stop).
   * Returns true when the row was updated.
   */
  updateProject(id: string, patch: ProjectPatch, expectedStates?: ProjectState[]): boolean {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch) as Array<[keyof ProjectPatch, unknown]>) {
      if (value === undefined) continue;
      sets.push(`${PROJECT_COLUMNS[key]} = ?`);
      // Free text (context, activity, reasons) can echo provider output or user pastes: redact before persisting.
      params.push(
        value === null
          ? null
          : typeof value === "object"
            ? JSON.stringify(redactDeep(value))
            : typeof value === "string"
              ? redact(value)
              : (value as SQLInputValue),
      );
    }
    sets.push("updated_at = ?");
    params.push(this.now());
    let where = "id = ?";
    params.push(id);
    if (expectedStates?.length) {
      where += ` AND state IN (${expectedStates.map(() => "?").join(", ")})`;
      params.push(...expectedStates);
    }
    return this.run(`UPDATE projects SET ${sets.join(", ")} WHERE ${where}`, ...params) === 1;
  }

  addSpend(id: string, cents: number): void {
    if (cents > 0) this.run(`UPDATE projects SET spent_cents = spent_cents + ? WHERE id = ?`, Math.round(cents), id);
  }

  /** Projects the worker should look at now. */
  listDueProjects(limit: number): Project[] {
    const now = this.now();
    return this.all(
      `SELECT * FROM projects
       WHERE state = 'working'
         AND (next_run_at IS NULL OR next_run_at <= ?)
         AND (lease_owner IS NULL OR lease_until < ?)
       ORDER BY COALESCE(next_run_at, created_at) ASC LIMIT ?`,
      now,
      now,
      limit,
    ).map(mapProject);
  }

  /** Atomically acquire the per-project lease. Only one worker can hold it at a time. */
  acquireLease(projectId: string, owner: string, ttlMs: number): boolean {
    const now = this.clock();
    const until = new Date(now.getTime() + ttlMs).toISOString();
    return (
      this.run(
        `UPDATE projects SET lease_owner = ?, lease_until = ?
         WHERE id = ? AND (lease_owner IS NULL OR lease_until < ? OR lease_owner = ?)`,
        owner,
        until,
        projectId,
        now.toISOString(),
        owner,
      ) === 1
    );
  }

  releaseLease(projectId: string, owner: string): void {
    this.run(`UPDATE projects SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?`, projectId, owner);
  }

  // ---------------------------------------------------------------- criteria

  listCriteria(projectId: string): AcceptanceCriterion[] {
    return this.all(`SELECT * FROM criteria WHERE project_id = ? ORDER BY position`, projectId).map(mapCriterion);
  }

  getCriterion(id: string): AcceptanceCriterion | null {
    const r = this.get(`SELECT * FROM criteria WHERE id = ?`, id);
    return r ? mapCriterion(r) : null;
  }

  updateCriterion(
    id: string,
    patch: { status: AcceptanceCriterion["status"]; evidence?: string | null; feedback?: string | null },
  ): void {
    this.run(
      `UPDATE criteria SET status = ?, evidence = COALESCE(?, evidence), feedback = ?, verified_at = ? WHERE id = ?`,
      patch.status,
      patch.evidence === undefined ? null : patch.evidence === null ? null : redact(patch.evidence),
      patch.feedback ?? null,
      patch.status === "verified" ? this.now() : null,
      id,
    );
  }

  // ---------------------------------------------------------------- tasks

  listTasks(projectId: string): Task[] {
    return this.all(`SELECT * FROM tasks WHERE project_id = ? ORDER BY position`, projectId).map(mapTask);
  }

  getTask(id: string): Task | null {
    const r = this.get(`SELECT * FROM tasks WHERE id = ?`, id);
    return r ? mapTask(r) : null;
  }

  createTask(input: {
    projectId: string;
    title: string;
    description: string;
    actionKind: ActionKind;
    source: TaskSource;
    criterionId?: string | null;
  }): Task {
    const id = randomUUID();
    const now = this.now();
    const pos = num(this.get(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE project_id = ?`, input.projectId)?.p);
    this.run(
      `INSERT INTO tasks (id, project_id, position, title, description, action_kind, status, source, criterion_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      id,
      input.projectId,
      pos,
      redact(input.title),
      redact(input.description),
      input.actionKind,
      input.source,
      input.criterionId ?? null,
      now,
      now,
    );
    return this.getTask(id)!;
  }

  updateTask(
    id: string,
    patch: Partial<Pick<Task, "status" | "attempts" | "approvedAt" | "resultSummary" | "lastError">>,
  ): void {
    const cols: Record<string, string> = {
      status: "status",
      attempts: "attempts",
      approvedAt: "approved_at",
      resultSummary: "result_summary",
      lastError: "last_error",
    };
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      params.push(typeof v === "string" ? redact(v) : (v as SQLInputValue));
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    params.push(this.now(), id);
    this.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  // ---------------------------------------------------------------- dispatches

  /**
   * Record a dispatch before calling the adapter. Returns null when a dispatch with the same
   * idempotency key exists or another dispatch is already open for the project.
   */
  createDispatch(input: { projectId: string; taskId: string; idempotencyKey: string; adapter: string }): Dispatch | null {
    const id = randomUUID();
    try {
      this.run(
        `INSERT INTO dispatches (id, project_id, task_id, idempotency_key, adapter, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'in_flight', ?)`,
        id,
        input.projectId,
        input.taskId,
        input.idempotencyKey,
        input.adapter,
        this.now(),
      );
    } catch (err) {
      if (String((err as Error).message).includes("UNIQUE")) return null;
      throw err;
    }
    return this.getDispatch(id);
  }

  getDispatch(id: string): Dispatch | null {
    const r = this.get(`SELECT * FROM dispatches WHERE id = ?`, id);
    return r ? mapDispatch(r) : null;
  }

  getOpenDispatch(projectId: string): Dispatch | null {
    const r = this.get(
      `SELECT * FROM dispatches WHERE project_id = ? AND status IN ('in_flight', 'awaiting_handoff')`,
      projectId,
    );
    return r ? mapDispatch(r) : null;
  }

  /** Monotonic sequence number for the next dispatch of a task (never reused, unlike retry counters). */
  nextDispatchSeq(taskId: string): number {
    return num(this.get(`SELECT COUNT(*) AS n FROM dispatches WHERE task_id = ?`, taskId)?.n) + 1;
  }

  listDispatches(projectId: string): Dispatch[] {
    return this.all(`SELECT * FROM dispatches WHERE project_id = ? ORDER BY started_at DESC`, projectId).map(mapDispatch);
  }

  /**
   * Transition a dispatch. `from` guards against applying a late result to a dispatch that was
   * already closed (e.g. abandoned because the user stopped the project).
   */
  updateDispatch(
    id: string,
    from: DispatchStatus[],
    patch: Partial<Pick<Dispatch, "status" | "externalRef" | "costCents" | "summary" | "error">>,
  ): boolean {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    const cols: Record<string, string> = {
      status: "status",
      externalRef: "external_ref",
      costCents: "cost_cents",
      summary: "summary",
      error: "error",
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      params.push(typeof v === "string" ? redact(v) : (v as SQLInputValue));
    }
    if (patch.status && !["in_flight", "awaiting_handoff"].includes(patch.status)) {
      sets.push("finished_at = ?");
      params.push(this.now());
    }
    params.push(id, ...from);
    return (
      this.run(
        `UPDATE dispatches SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
        ...params,
      ) === 1
    );
  }

  // ---------------------------------------------------------------- artifacts

  addArtifact(input: {
    projectId: string;
    taskId?: string | null;
    dispatchId?: string | null;
    kind: ArtifactKind;
    name: string;
    content: string;
    source: string;
    simulated: boolean;
  }): Artifact {
    const id = randomUUID();
    const content = redact(input.content);
    this.run(
      `INSERT INTO artifacts (id, project_id, task_id, dispatch_id, kind, name, content, content_hash, source, simulated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.taskId ?? null,
      input.dispatchId ?? null,
      input.kind,
      redact(input.name),
      content,
      artifactHash(input.kind, input.name, input.content),
      input.source,
      input.simulated ? 1 : 0,
      this.now(),
    );
    return mapArtifact(this.get(`SELECT * FROM artifacts WHERE id = ?`, id)!);
  }

  listArtifacts(projectId: string): Artifact[] {
    return this.all(`SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`, projectId).map(
      mapArtifact,
    );
  }

  hasArtifactHash(projectId: string, hash: string, excludeDispatchId: string): boolean {
    return !!this.get(
      `SELECT 1 FROM artifacts WHERE project_id = ? AND content_hash = ? AND COALESCE(dispatch_id, '') <> ? LIMIT 1`,
      projectId,
      hash,
      excludeDispatchId,
    );
  }

  // ---------------------------------------------------------------- attention

  /**
   * Raise an attention item. Deduplicated by (project, dedupeKey) while pending so the user is never
   * asked the same open question twice. Returns the existing item if one is already pending.
   */
  raiseAttention(input: {
    projectId: string;
    kind: AttentionKind;
    dedupeKey: string;
    title: string;
    detail: string;
    actions: AttentionAction[];
    taskId?: string | null;
    dispatchId?: string | null;
    criterionId?: string | null;
  }): { item: AttentionItem; created: boolean } {
    const existing = this.get(
      `SELECT * FROM attention_items WHERE project_id = ? AND dedupe_key = ? AND status = 'pending'`,
      input.projectId,
      input.dedupeKey,
    );
    if (existing) return { item: mapAttention(existing), created: false };
    const id = randomUUID();
    this.run(
      `INSERT INTO attention_items (id, project_id, task_id, dispatch_id, criterion_id, kind, dedupe_key, title, detail, actions, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      input.projectId,
      input.taskId ?? null,
      input.dispatchId ?? null,
      input.criterionId ?? null,
      input.kind,
      input.dedupeKey,
      redact(input.title),
      redact(input.detail),
      JSON.stringify(input.actions),
      this.now(),
    );
    return { item: this.getAttention(id)!, created: true };
  }

  getAttention(id: string): AttentionItem | null {
    const r = this.get(`SELECT * FROM attention_items WHERE id = ?`, id);
    return r ? mapAttention(r) : null;
  }

  listAttention(projectId: string): AttentionItem[] {
    return this.all(`SELECT * FROM attention_items WHERE project_id = ? ORDER BY created_at DESC`, projectId).map(
      mapAttention,
    );
  }

  listPendingAttention(projectId?: string): AttentionItem[] {
    const sql = `SELECT a.*, p.name AS project_name FROM attention_items a JOIN projects p ON p.id = a.project_id
                 WHERE a.status = 'pending' ${projectId ? "AND a.project_id = ?" : ""} ORDER BY a.created_at ASC`;
    return (projectId ? this.all(sql, projectId) : this.all(sql)).map(mapAttention);
  }

  resolveAttention(id: string, status: Exclude<AttentionStatus, "pending">, resolution: string | null): boolean {
    return (
      this.run(
        `UPDATE attention_items SET status = ?, resolution = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
        status,
        resolution === null ? null : redact(resolution),
        this.now(),
        id,
      ) === 1
    );
  }

  supersedeAttention(projectId: string, reason: string, kinds?: AttentionKind[]): number {
    const kindFilter = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
    return this.run(
      `UPDATE attention_items SET status = 'superseded', resolution = ?, resolved_at = ?
       WHERE project_id = ? AND status = 'pending'${kindFilter}`,
      reason,
      this.now(),
      projectId,
      ...(kinds ?? []),
    );
  }

  // ---------------------------------------------------------------- audit trail

  log(projectId: string | null, actor: string, type: string, message: string, data?: Record<string, unknown>): void {
    this.run(
      `INSERT INTO events (project_id, ts, actor, type, message, data) VALUES (?, ?, ?, ?, ?, ?)`,
      projectId,
      this.now(),
      actor,
      type,
      redact(message),
      data ? JSON.stringify(redactDeep(data)) : null,
    );
  }

  listEvents(projectId: string, limit = 300): ActivityEvent[] {
    return this.all(`SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?`, projectId, limit).map(mapEvent);
  }
}
