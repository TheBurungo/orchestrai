import type { AdapterInfo } from "../../shared/types.js";
import { MODEL_SYSTEM_PROMPT, buildTaskPrompt, parseModelText } from "./output.js";
import type { DispatchOutcome, DispatchRequest, ProviderAdapter } from "./types.js";

export type FetchLike = typeof fetch;

export interface ModelPricing {
  /** US cents per million input tokens. */
  inputCentsPerMTok: number;
  /** US cents per million output tokens. */
  outputCentsPerMTok: number;
}

export interface ModelAdapterOptions {
  apiKey: string | undefined;
  defaultModel: string;
  pricing: ModelPricing;
  maxOutputTokens: number;
  fetchImpl?: FetchLike;
}

interface ModelCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Thrown for HTTP failures so the orchestrator can apply bounded retries and honour Retry-After. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export async function providerFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  providerName: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    if ((err as Error).name === "AbortError" || init.signal?.aborted) throw new ProviderHttpError(`${providerName} request timed out`, true);
    throw new ProviderHttpError(`${providerName} network error: ${(err as Error).message}`, true);
  }
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    throw new ProviderHttpError(
      `${providerName} returned HTTP ${res.status}${body ? `: ${body}` : ""}`,
      retryable,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
  return res.json();
}

abstract class ModelApiAdapter implements ProviderAdapter {
  protected readonly fetchImpl: FetchLike;

  constructor(protected readonly options: ModelAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  protected abstract info(): Omit<AdapterInfo, "configured" | "configurationHint" | "configFields" | "category" | "live" | "verificationRules" | "trustedChecks">;
  protected abstract call(model: string, system: string, user: string, signal: AbortSignal): Promise<ModelCallResult>;
  protected abstract readonly envKeyName: string;

  describe(): AdapterInfo {
    return {
      ...this.info(),
      category: "model_api",
      live: true,
      configured: !!this.options.apiKey,
      configurationHint: this.options.apiKey ? null : `Set ${this.envKeyName} in the server environment (.env).`,
      configFields: [
        { key: "model", label: "Model", required: false, placeholder: this.options.defaultModel },
      ],
      verificationRules: [],
      trustedChecks: false,
    };
  }

  validateConfig(config: Record<string, string>): string[] {
    if (config.model && !/^[A-Za-z0-9._:\-/]{1,100}$/.test(config.model)) return ["model contains unsupported characters"];
    return [];
  }

  estimateCostCents(req: Omit<DispatchRequest, "signal">): number {
    const inputTokens = Math.ceil((MODEL_SYSTEM_PROMPT.length + buildTaskPrompt(req).length) / 3);
    return Math.ceil(this.costOf(inputTokens, this.options.maxOutputTokens));
  }

  private costOf(inputTokens: number, outputTokens: number): number {
    const p = this.options.pricing;
    return (inputTokens * p.inputCentsPerMTok + outputTokens * p.outputCentsPerMTok) / 1_000_000;
  }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    if (!this.options.apiKey) {
      return { status: "failed", error: `${this.envKeyName} is not configured on the server`, retryable: false };
    }
    const model = req.config.model || this.options.defaultModel;
    let result: ModelCallResult;
    try {
      result = await this.call(model, MODEL_SYSTEM_PROMPT, buildTaskPrompt(req), req.signal);
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        return { status: "failed", error: err.message, retryable: err.retryable, retryAfterMs: err.retryAfterMs };
      }
      return { status: "failed", error: (err as Error).message, retryable: true };
    }
    const costCents = Math.ceil(this.costOf(result.inputTokens, result.outputTokens));
    try {
      const output = parseModelText(result.text);
      // Model-reported checks are self-assessments, not executed checks; keep them as text only.
      if (output.checks.length) {
        output.artifacts.push({
          kind: "text",
          name: "agent-reported-checks.txt",
          content: output.checks.map((c) => `${c.passed ? "PASS" : "FAIL"} ${c.name}${c.detail ? ` – ${c.detail}` : ""}`).join("\n"),
        });
        output.checks = [];
      }
      return { status: "completed", output, costCents };
    } catch (err) {
      return { status: "failed", error: (err as Error).message, retryable: true, costCents };
    }
  }

  /** Model API calls have no side effects beyond cost, so an interrupted call is safe to redo. */
  async recover(): Promise<DispatchOutcome | null> {
    return null;
  }
}

export class OpenAIAdapter extends ModelApiAdapter {
  protected readonly envKeyName = "OPENAI_API_KEY";

  protected info() {
    return {
      id: "openai",
      name: "OpenAI API",
      description:
        "Calls the OpenAI API (platform.openai.com) with your API key. Each dispatch is a fresh, stateless request – it cannot see or continue ChatGPT conversations or ChatGPT Projects.",
      capabilities: [
        "Generates text/code deliverables returned as artifacts",
        "Usage-based cost tracking from reported token usage and your configured prices",
      ],
      limitations: [
        "No access to ChatGPT Projects, chats, memory or files – supply needed context in the project",
        "Does not execute code or tests; self-reported checks are not counted as evidence",
      ],
    };
  }

  protected async call(model: string, system: string, user: string, signal: AbortSignal): Promise<ModelCallResult> {
    const body = (await providerFetch(
      this.fetchImpl,
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: ["Bearer", this.options.apiKey ?? ""].join(" ") },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          max_completion_tokens: this.options.maxOutputTokens,
        }),
      },
      "OpenAI",
    )) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }
}

export class AnthropicAdapter extends ModelApiAdapter {
  protected readonly envKeyName = "ANTHROPIC_API_KEY";

  protected info() {
    return {
      id: "anthropic",
      name: "Anthropic API",
      description:
        "Calls the Anthropic Messages API with your API key. Each dispatch is a fresh, stateless request – it cannot see or continue Claude.ai chats or Claude Projects.",
      capabilities: [
        "Generates text/code deliverables returned as artifacts",
        "Usage-based cost tracking from reported token usage and your configured prices",
      ],
      limitations: [
        "No access to Claude.ai Projects, chats or project knowledge – supply needed context in the project",
        "Does not execute code or tests; self-reported checks are not counted as evidence",
      ],
    };
  }

  protected async call(model: string, system: string, user: string, signal: AbortSignal): Promise<ModelCallResult> {
    const body = (await providerFetch(
      this.fetchImpl,
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: this.options.maxOutputTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      },
      "Anthropic",
    )) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"),
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
  }
}
