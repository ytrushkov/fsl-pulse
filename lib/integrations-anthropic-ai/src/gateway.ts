import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic } from "./client";

/**
 * LLM gateway — the single sanctioned path for sending prompts to the model
 * provider. Per the PRD / CLAUDE.md, raw client PII must never leave for a
 * provider, so every message (and system prompt) is run through `redactPii`
 * before the request is made.
 *
 * This is a conservative, pattern-based v1: it removes the highest-risk direct
 * identifiers (emails, phone numbers, IPv4 addresses) plus any caller-supplied
 * `redactTerms` (e.g. interviewee names the caller already knows). It
 * deliberately does NOT redact numbers in general, because the assessment
 * prompts carry scores, percentages and evidence ids the model needs intact.
 * Broader name/entity redaction beyond `redactTerms` is a known follow-up.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Narrow phone patterns chosen to avoid eating score/evidence numbers:
// international (+country …) and US (xxx) xxx-xxxx / xxx-xxx-xxxx forms.
const PHONE_INTL_RE = /\+\d[\d\s().-]{7,}\d/g;
const PHONE_US_RE = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactPii(text: string, redactTerms: string[] = []): string {
  let out = text
    .replace(EMAIL_RE, "[EMAIL]")
    .replace(PHONE_INTL_RE, "[PHONE]")
    .replace(PHONE_US_RE, "[PHONE]")
    .replace(IPV4_RE, "[IP]");
  for (const term of redactTerms) {
    const t = term.trim();
    if (t.length < 3) continue; // too short → unsafe to blanket-replace
    out = out.replace(new RegExp(escapeRegExp(t), "gi"), "[REDACTED]");
  }
  return out;
}

function redactContent(
  content: Anthropic.MessageParam["content"],
  terms: string[],
): Anthropic.MessageParam["content"] {
  if (typeof content === "string") return redactPii(content, terms);
  return content.map((block) =>
    block.type === "text"
      ? { ...block, text: redactPii(block.text, terms) }
      : block,
  );
}

function redactSystem(
  system: NonNullable<Anthropic.MessageCreateParams["system"]>,
  terms: string[],
): NonNullable<Anthropic.MessageCreateParams["system"]> {
  if (typeof system === "string") return redactPii(system, terms);
  return system.map((block) => ({ ...block, text: redactPii(block.text, terms) }));
}

export type GatewayMessageParams =
  Anthropic.MessageCreateParamsNonStreaming & {
    /** Extra literal terms to redact (case-insensitive), e.g. participant names. */
    redactTerms?: string[];
  };

/** Create a message with PII redaction applied to all outgoing prompt text. */
export async function createMessage(
  params: GatewayMessageParams,
): Promise<Anthropic.Message> {
  const { redactTerms = [], ...rest } = params;
  const scrubbed: Anthropic.MessageCreateParamsNonStreaming = {
    ...rest,
    messages: rest.messages.map((m) => ({
      ...m,
      content: redactContent(m.content, redactTerms),
    })),
    ...(rest.system ? { system: redactSystem(rest.system, redactTerms) } : {}),
  };
  return getAnthropic().messages.create(scrubbed);
}
