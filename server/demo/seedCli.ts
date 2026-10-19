import { buildAdapters, loadConfig, loadEnvFile } from "../config.js";
import { Orchestrator } from "../orchestrator/engine.js";
import { Store } from "../store.js";
import { seedDemoProjects } from "./seed.js";

loadEnvFile();
const config = loadConfig();
const store = new Store(config.dbPath);
const projects = seedDemoProjects(new Orchestrator(store, buildAdapters()));
console.log(`Created ${projects.length} demo projects in ${config.dbPath}`);
store.close();
