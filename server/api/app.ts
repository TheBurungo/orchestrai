import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ACTION_KINDS,
  AUTONOMY_LEVELS,
  DEFAULT_LIMITS,
  DEFAULT_POLICY,
  type Overview,
  type ProjectDetail,
} from "../../shared/types.js";
import { CommandError, type Orchestrator } from "../orchestrator/engine.js";
import { redactDeep } from "../security/redact.js";
import { seedDemoProjects } from "../demo/seed.js";

const actionKind = z.enum(ACTION_KINDS);

const ruleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("artifact_exists"), artifact: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal("artifact_contains"), artifact: z.string().trim().min(1).max(200), text: z.string().min(1).max(500) }),
  z.object({ type: z.literal("check_passed"), check: z.string().trim().min(1).max(200) }),
  z.object({
    type: z.literal("github_file_contains"),
    path: z.string().trim().min(1).max(500),
    text: z.string().min(1).max(500),
    ref: z.string().trim().max(200).optional(),
  }),
  z.object({ type: z.literal("github_checks_pass"), ref: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal("manual") }),
]);

const policySchema = z.object({
  requireApproval: z.array(actionKind).max(ACTION_KINDS.length),
  deny: z.array(actionKind).max(ACTION_KINDS.length),
  checkpointEvery: z.number().int().min(0).max(1000),
});

const limitsSchema = z.object({
  budgetCents: z.number().int().min(0).max(100_000_000),
  maxSteps: z.number().int().min(1).max(10_000),
  maxAttemptsPerTask: z.number().int().min(1).max(20),
  stallLimit: z.number().int().min(1).max(100),
});

const configSchema = z
  .record(z.string().max(50), z.string().max(500))
  .refine((r) => Object.keys(r).length <= 20, "Too many config keys");

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(4000),
  constraints: z.string().max(4000).default(""),
  context: z.string().max(20_000).default(""),
  adapter: z.string().min(1).max(50),
  adapterConfig: configSchema.default({}),
  autonomy: z.enum(AUTONOMY_LEVELS).default("supervised"),
  policy: policySchema.default(DEFAULT_POLICY),
  limits: limitsSchema.default(DEFAULT_LIMITS),
  criteria: z
    .array(z.object({ description: z.string().trim().min(1).max(500), rule: ruleSchema }))
    .min(1, "Add at least one acceptance criterion – completion must be verifiable")
    .max(30),
  start: z.boolean().default(false),
});

const settingsSchema = z.object({
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
  policy: policySchema.optional(),
  limits: limitsSchema.optional(),
  adapterConfig: configSchema.optional(),
  context: z.string().max(20_000).optional(),
});

const resolveSchema = z.object({
  action: z.enum(["approve", "reject", "respond"]),
  note: z.string().max(100_000).nullable().optional(),
});

const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  actionKind: z.string().max(50).default("write_code"),
});

const guidanceSchema = z.object({ text: z.string().trim().min(1).max(20_000) });

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function createApp(orchestrator: Orchestrator, opts: { workerEnabled: boolean; allowedHosts: string[]; staticDir?: string }) {
  const { store, adapters } = orchestrator;
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    // DNS-rebinding protection: only answer requests addressed to this machine (or explicitly allowed hosts).
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!LOOPBACK_HOSTS.has(host) && !opts.allowedHosts.includes(host)) {
      res.status(403).json({ error: "Host not allowed" });
      return;
    }
    next();
  });

  // Mutations must be JSON: browsers cannot send cross-origin JSON without a CORS preflight, which this server never grants.
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json")) {
      res.status(415).json({ error: "Content-Type must be application/json" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  const api = express.Router();

  api.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  api.get("/adapters", (_req, res) => {
    res.json(adapters.list().map((a) => ({ ...a, supportedRules: adapters.supportedRules(a.id) })));
  });

  api.get("/overview", (_req, res) => {
    const overview: Overview = {
      projects: store.listProjectSummaries(adapters.simulatedIds()),
      attention: store.listPendingAttention(),
      worker: { enabled: opts.workerEnabled, workerId: orchestrator.options.workerId },
    };
    res.json(overview);
  });

  api.post("/projects", (req, res) => {
    const input = createProjectSchema.parse(req.body);
    const adapter = adapters.get(input.adapter);
    if (!adapter) throw new CommandError(`Unknown adapter "${input.adapter}"`, 400);
    const configErrors = adapter.validateConfig(input.adapterConfig);
    if (configErrors.length) throw new CommandError(`Invalid adapter configuration: ${configErrors.join("; ")}`, 400);
    const supported = adapters.supportedRules(input.adapter);
    const unsupported = input.criteria.filter((c) => !supported.includes(c.rule.type));
    if (unsupported.length) {
      throw new CommandError(
        `The ${adapter.describe().name} adapter cannot verify: ${[...new Set(unsupported.map((c) => c.rule.type))].join(", ")}`,
        400,
      );
    }
    const project = store.createProject({ ...input, policy: input.policy, limits: input.limits });
    store.log(project.id, "user", "project_created", `Created project "${project.name}"`, {
      adapter: input.adapter,
      autonomy: input.autonomy,
      policy: input.policy,
      limits: input.limits,
    });
    res.status(201).json(input.start ? orchestrator.start(project.id) : project);
  });

  api.get("/projects/:id", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) throw new CommandError("Project not found", 404);
    const detail: ProjectDetail = {
      project,
      adapter: adapters.get(project.adapter)?.describe() ?? null,
      criteria: store.listCriteria(project.id),
      tasks: store.listTasks(project.id),
      dispatches: store.listDispatches(project.id),
      artifacts: store.listArtifacts(project.id),
      attention: store.listAttention(project.id),
      events: store.listEvents(project.id),
    };
    res.json(detail);
  });

  api.patch("/projects/:id/settings", (req, res) => {
    const patch = settingsSchema.parse(req.body);
    const project = store.getProject(req.params.id);
    if (!project) throw new CommandError("Project not found", 404);
    if (patch.adapterConfig) {
      const errors = adapters.get(project.adapter)?.validateConfig(patch.adapterConfig) ?? [];
      if (errors.length) throw new CommandError(`Invalid adapter configuration: ${errors.join("; ")}`, 400);
    }
    store.updateProject(project.id, patch);
    // Policy and limit changes are only possible through this authenticated-by-locality user API, and are audited.
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) before[key] = project[key];
    store.log(project.id, "user", "settings_changed", `Updated ${Object.keys(patch).join(", ") || "nothing"}`, redactDeep({ before, after: patch }));
    res.json(store.getProject(project.id));
  });

  for (const command of ["start", "pause", "resume", "stop"] as const) {
    api.post(`/projects/:id/${command}`, (req, res) => {
      res.json(orchestrator[command](req.params.id as string));
    });
  }

  api.post("/projects/:id/tasks", (req, res) => {
    const input = taskSchema.parse(req.body);
    res.status(201).json(orchestrator.addTask(req.params.id as string, input));
  });

  api.post("/projects/:id/guidance", (req, res) => {
    const input = guidanceSchema.parse(req.body);
    orchestrator.addGuidance(req.params.id as string, input.text);
    res.status(201).json({ ok: true });
  });

  api.post("/attention/:id/resolve", (req, res) => {
    const input = resolveSchema.parse(req.body);
    res.json(orchestrator.resolveAttention(req.params.id as string, input.action, input.note ?? null));
  });

  api.post("/demo/seed", (_req, res) => {
    res.status(201).json(seedDemoProjects(orchestrator));
  });

  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  if (opts.staticDir && existsSync(opts.staticDir)) {
    const dir = resolve(opts.staticDir);
    app.use(express.static(dir, { index: false }));
    app.get(/.*/, (_req, res) => {
      res.sendFile(join(dir, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
      return;
    }
    if (err instanceof CommandError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if ((err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "Malformed JSON" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}
