import { describe, it, expect } from "vitest";
import { redactPii } from "@workspace/integrations-anthropic-ai";

describe("redactPii", () => {
  it("redacts email addresses", () => {
    expect(redactPii("reach me at jane.doe@acme.co please")).toBe(
      "reach me at [EMAIL] please",
    );
  });

  it("redacts international and US phone numbers", () => {
    expect(redactPii("call +1 415 555 0132 today")).toBe("call [PHONE] today");
    expect(redactPii("office (415) 555-0132")).toBe("office [PHONE]");
    expect(redactPii("mobile 415-555-0132")).toBe("mobile [PHONE]");
  });

  it("redacts IPv4 addresses", () => {
    expect(redactPii("logged in from 10.0.12.44")).toBe("logged in from [IP]");
  });

  it("redacts caller-supplied terms case-insensitively", () => {
    expect(
      redactPii("Alice said the tooling is weak", ["Alice"]),
    ).toBe("[REDACTED] said the tooling is weak");
    expect(redactPii("per ALICE", ["alice"])).toBe("per [REDACTED]");
  });

  it("ignores redact terms shorter than 3 chars (too unsafe to blanket-replace)", () => {
    expect(redactPii("a or an", ["a"])).toBe("a or an");
  });

  it("preserves scoring numbers, percentages, and evidence ids", () => {
    const analytical =
      "dimension tooling stage 3, score 62, confidence 0.8, coverage 45% [ev-17]";
    expect(redactPii(analytical)).toBe(analytical);
  });

  it("is a no-op when there is nothing to redact", () => {
    expect(redactPii("plain assessment narrative")).toBe(
      "plain assessment narrative",
    );
  });
});
