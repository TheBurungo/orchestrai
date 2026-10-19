import { randomUUID } from "node:crypto";
import { createApp } from "./api/app.js";
import { buildAdapters, loadConfig, loadEnvFile } from "./config.js";
import { Orchestrator } from "./orchestrator/engine.js";
import { Store } from "./store.js";
import { Worker } from "./worker.js";

loadEnvFile();
const config = loadConfig();

const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
if (!loopback && !config.allowRemote) {
  console.error(
    `Refusing to listen on ${config.host}: the API has no authentication and is meant for local use. ` +
      "Set ORCHESTRAI_ALLOW_REMOTE=true only behind your own authenticating proxy.",
  );
  process.exit(1);
}

const store = new Store(config.dbPath);
const orchestrator = new Orchestrator(store, buildAdapters(), { workerId: `server-${randomUUID().slice(0, 8)}` });
const worker = new Worker(orchestrator, config.workerIntervalMs, config.workerConcurrency);

const app = createApp(orchestrator, {
  workerEnabled: config.workerEnabled,
  allowedHosts: config.allowedHosts,
  staticDir: "dist/web",
});

const server = app.listen(config.port, config.host, () => {
  console.log(`OrchestrAI API listening on http://${config.host}:${config.port}`);
  console.log(`Database: ${config.dbPath}`);
  for (const a of orchestrator.adapters.list()) {
    console.log(`  adapter ${a.id.padEnd(10)} ${a.live ? "live     " : "SIMULATED"} ${a.configured ? "configured" : `not configured (${a.configurationHint})`}`);
  }
  if (config.workerEnabled) {
    worker.start();
    console.log("Background worker started");
  }
});

function shutdown() {
  worker.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
