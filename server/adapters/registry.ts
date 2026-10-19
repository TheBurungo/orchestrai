import type { AdapterInfo, VerificationRule } from "../../shared/types.js";
import type { ProviderAdapter } from "./types.js";

const GENERIC_RULES: VerificationRule["type"][] = ["artifact_exists", "artifact_contains", "manual"];

export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    this.adapters.set(adapter.describe().id, adapter);
    return this;
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AdapterInfo[] {
    return [...this.adapters.values()].map((a) => a.describe());
  }

  simulatedIds(): Set<string> {
    return new Set(this.list().filter((a) => !a.live).map((a) => a.id));
  }

  /** Verification rule types that can actually be evaluated for projects using this adapter. */
  supportedRules(id: string): VerificationRule["type"][] {
    const info = this.get(id)?.describe();
    if (!info) return [];
    return [...GENERIC_RULES, ...(info.trustedChecks ? (["check_passed"] as const) : []), ...info.verificationRules];
  }
}
