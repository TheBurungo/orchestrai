import type { AdapterInfo } from "../../shared/types.js";
import { buildTaskPrompt } from "./output.js";
import type { DispatchOutcome, DispatchRequest, ProviderAdapter } from "./types.js";

export const HANDOFF_TARGETS = ["ChatGPT Project", "Claude Project", "Lovable", "Other"] as const;

/**
 * For products whose existing projects/conversations cannot be driven through a public API
 * (ChatGPT Projects, Claude.ai Projects, Lovable chats, …). The orchestrator still plans, tracks,
 * gates and verifies, but delivery is done by the user: it prepares a ready-to-paste prompt and the
 * user pastes the response back. Nothing is sent anywhere automatically.
 */
export class ManualHandoffAdapter implements ProviderAdapter {
  describe(): AdapterInfo {
    return {
      id: "manual",
      name: "Manual handoff",
      category: "manual_handoff",
      live: true,
      configured: true,
      configurationHint: null,
      description:
        "Prepares a self-contained prompt for a product without a supported control API (ChatGPT Projects, Claude Projects, Lovable). You paste it there and paste the reply back; the orchestrator verifies and plans the next step.",
      capabilities: [
        "Builds a complete, copy-ready prompt with goal, constraints, criteria, feedback and prior artifacts",
        "Tracks each handoff in the attention queue and resumes when you paste the response",
        "Verifies the pasted response against acceptance criteria",
      ],
      limitations: [
        "Does not read or write your ChatGPT/Claude/Lovable conversations – there is no supported public API for that",
        "Requires you to copy and paste each turn",
      ],
      configFields: [
        { key: "target", label: "Where you will paste the prompt", required: false, options: [...HANDOFF_TARGETS] },
        {
          key: "url",
          label: "Link to the project/conversation (optional)",
          required: false,
          placeholder: "https://…",
          help: "Shown as a convenience link only; it is never fetched.",
        },
      ],
      verificationRules: [],
      trustedChecks: false,
    };
  }

  validateConfig(config: Record<string, string>): string[] {
    const errors: string[] = [];
    if (config.url && !/^https:\/\/\S+$/i.test(config.url)) errors.push("url must be an https:// link");
    return errors;
  }

  estimateCostCents(): number {
    return 0;
  }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    const target = req.config.target || "the AI tool you use for this project";
    const prompt = buildTaskPrompt(req);
    const instructions = [
      `Paste the prompt below into ${target}${req.config.url ? ` (${req.config.url})` : ""}, then paste the full reply back here.`,
      "Ask it to return complete deliverables; they will be checked against the acceptance criteria.",
      "",
      "----- PROMPT -----",
      prompt,
      "----- END PROMPT -----",
    ].join("\n");
    return { status: "handoff", instructions };
  }

  async recover(): Promise<DispatchOutcome | null> {
    return null;
  }
}
