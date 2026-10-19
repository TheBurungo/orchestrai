import { existsSync } from "node:fs";
import { AdapterRegistry } from "./adapters/registry.js";
import { DemoAdapter } from "./adapters/demo.js";
import { GitHubAdapter } from "./adapters/github.js";
import { ManualHandoffAdapter } from "./adapters/manual.js";
import { AnthropicAdapter, OpenAIAdapter } from "./adapters/modelApi.js";
import { registerSecret } from "./security/redact.js";

export interface Config {
  host: string;
  port: number;
  allowRemote: boolean;
  allowedHosts: string[];
  dbPath: string;
  workerEnabled: boolean;
  workerIntervalMs: number;
  workerConcurrency: number;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

export function loadEnvFile(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

export function loadConfig(): Config {
  return {
    host: process.env.HOST || "127.0.0.1",
    port: int("PORT", 8787),
    allowRemote: process.env.ORCHESTRAI_ALLOW_REMOTE === "true",
    allowedHosts: (process.env.ALLOWED_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean),
    dbPath: process.env.DATABASE_PATH || "./data/orchestrai.db",
    workerEnabled: process.env.WORKER_ENABLED !== "false",
    workerIntervalMs: int("WORKER_INTERVAL_MS", 1000),
    workerConcurrency: int("WORKER_CONCURRENCY", 4),
  };
}

/** Build adapters from server-side environment variables. Credentials never leave the server. */
export function buildAdapters(): AdapterRegistry {
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) registerSecret(process.env[key]);
  return new AdapterRegistry()
    .register(new DemoAdapter({ delayMs: int("DEMO_DELAY_MS", 1200) }))
    .register(new ManualHandoffAdapter())
    .register(
      new OpenAIAdapter({
        apiKey: process.env.OPENAI_API_KEY || undefined,
        defaultModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
        maxOutputTokens: int("OPENAI_MAX_OUTPUT_TOKENS", 4000),
        pricing: {
          inputCentsPerMTok: int("OPENAI_INPUT_CENTS_PER_MTOK", 15),
          outputCentsPerMTok: int("OPENAI_OUTPUT_CENTS_PER_MTOK", 60),
        },
      }),
    )
    .register(
      new AnthropicAdapter({
        apiKey: process.env.ANTHROPIC_API_KEY || undefined,
        defaultModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        maxOutputTokens: int("ANTHROPIC_MAX_OUTPUT_TOKENS", 4000),
        pricing: {
          inputCentsPerMTok: int("ANTHROPIC_INPUT_CENTS_PER_MTOK", 300),
          outputCentsPerMTok: int("ANTHROPIC_OUTPUT_CENTS_PER_MTOK", 1500),
        },
      }),
    )
    .register(new GitHubAdapter({ token: process.env.GITHUB_TOKEN || undefined, pollIntervalMs: int("GITHUB_POLL_INTERVAL_MS", 60_000) }));
}
