import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../api/app.js";
import type { Overview, Project } from "../../shared/types.js";
import { setup } from "./helpers.js";

let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

async function start() {
  const ctx = setup();
  const app = createApp(ctx.orchestrator, { workerEnabled: false, allowedHosts: [] });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return { ...ctx, base };
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const validProject = {
  name: "API project",
  goal: "Write docs",
  adapter: "demo",
  criteria: [{ description: "README exists", rule: { type: "artifact_exists", artifact: "README.md" } }],
};

describe("HTTP API", () => {
  it("rejects non-JSON mutations so cross-site form posts cannot trigger actions", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/demo/seed`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  it("creates a project, applying defaults, and reports it in the overview", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/projects`, json(validProject));
    expect(res.status).toBe(201);
    const project = (await res.json()) as Project;
    expect(project.state).toBe("ready");
    expect(project.autonomy).toBe("supervised");
    const overview = (await (await fetch(`${base}/overview`)).json()) as Overview;
    expect(overview.projects).toHaveLength(1);
    expect(overview.projects[0].simulated).toBe(true);
  });

  it("refuses criteria the adapter cannot produce evidence for", async () => {
    const { base } = await start();
    const res = await fetch(
      `${base}/projects`,
      json({ ...validProject, criteria: [{ description: "File on main", rule: { type: "github_file_contains", path: "README.md", text: "x" } }] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot verify: github_file_contains/);
  });

  it("requires at least one acceptance criterion", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/projects`, json({ ...validProject, criteria: [] }));
    expect(res.status).toBe(400);
  });

  it("returns a conflict-style error for invalid commands instead of changing state", async () => {
    const { base, store } = await start();
    const project = (await (await fetch(`${base}/projects`, json(validProject))).json()) as Project;
    const res = await fetch(`${base}/projects/${project.id}/resume`, json({}));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(store.getProject(project.id)!.state).toBe("ready");
  });
});
