import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null = null;

/**
 * Lazily construct the Anthropic client. Deferring construction (and the
 * env-var check) to first use means importing this package for the pure
 * gateway helpers (e.g. `redactPii`) doesn't require ANTHROPIC_API_KEY, which
 * keeps unit tests and tooling from tripping over missing credentials.
 *
 * Talks to the public Anthropic API by default; ANTHROPIC_BASE_URL can point
 * at a self-hosted proxy/gateway. No Replit dependency.
 */
export function getAnthropic(): Anthropic {
  if (cached) return cached;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY must be set. Configure Anthropic access for the LLM gateway.",
    );
  }
  cached = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...(process.env.ANTHROPIC_BASE_URL
      ? { baseURL: process.env.ANTHROPIC_BASE_URL }
      : {}),
  });
  return cached;
}

/**
 * Backward-compatible lazy client handle. Prefer `createMessage` from the
 * gateway, which enforces PII redaction; this is only for callers that need
 * the raw SDK surface.
 */
export const anthropic: Anthropic = new Proxy({} as Anthropic, {
  get(_target, prop, receiver) {
    const client = getAnthropic();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
