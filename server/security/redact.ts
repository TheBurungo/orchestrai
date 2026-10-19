// Secret redaction. Applied to everything persisted in logs, events, artifacts and
// attention items so credentials never reach the database or the browser.

const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi, `$1 ${REDACTED}`],
  [
    /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|client[_-]?secret)["']?\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi,
    `$1$2${REDACTED}$2`,
  ],
];

const knownSecrets = new Set<string>();

/** Register secret values (e.g. API keys from the environment) so they are always masked. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /^(api[_-]?key|token|secret|password|authorization)$/i.test(k) && typeof v === "string" ? REDACTED : redactDeep(v);
    }
    return out as T;
  }
  return value;
}
