// Standalone worker process (use with WORKER_ENABLED=false on the API server, or alongside it:
// per-project leases in SQLite prevent two workers from acting on the same project).
import { randomUUID } from "node:crypto";
import { buildAdapters, loadConfig, loadEnvFile } from "./config.js";
import { Orchestrator } from "./orchestrator/engine.js";
import { Store } from "./store.js";
import { Worker } from "./worker.js";

loadEnvFile();
const config = loadConfig();
const store = new Store(config.dbPath);
const orchestrator = new Orchestrator(store, buildAdapters(), { workerId: `worker-${randomUUID().slice(0, 8)}` });
const worker = new Worker(orchestrator, config.workerIntervalMs, config.workerConcurrency);
worker.start();
console.log(`OrchestrAI worker ${orchestrator.options.workerId} running against ${config.dbPath}`);

const shutdown = () => {
  worker.stop();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
