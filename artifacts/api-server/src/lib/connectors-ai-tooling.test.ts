import { describe, expect, it } from "vitest";
import { parseAdoptionCsv, computeAdoptionEvidence } from "./connectors";

describe("parseAdoptionCsv", () => {
  it("parses the documented schema and aggregates active users + suggestions", () => {
    const csv = [
      "user,active_days,suggestions_seen,suggestions_accepted",
      "alice@acme.com,12,420,210",
      "bob@acme.com,0,0,0",
      "carol@acme.com,3,80,40",
      "dan@acme.com,7,200,30",
    ].join("\n");
    const out = parseAdoptionCsv(csv);
    expect(out.rows).toBe(4);
    expect(out.activeUsers).toBe(3);
    expect(out.suggestionsSeen).toBe(700);
    expect(out.suggestionsAccepted).toBe(280);
  });

  it("is order-independent and tolerates whitespace + trailing newlines", () => {
    const csv = [
      "  suggestions_accepted , user, suggestions_seen ,active_days ",
      "10,alice,40,5",
      "0,bob,0,0",
      "",
    ].join("\r\n");
    const out = parseAdoptionCsv(csv);
    expect(out.rows).toBe(2);
    expect(out.activeUsers).toBe(1);
    expect(out.suggestionsSeen).toBe(40);
    expect(out.suggestionsAccepted).toBe(10);
  });

  it("treats missing optional columns as zero", () => {
    const csv = ["user", "alice", "bob", "carol"].join("\n");
    const out = parseAdoptionCsv(csv);
    expect(out.rows).toBe(3);
    expect(out.activeUsers).toBe(0);
    expect(out.suggestionsSeen).toBe(0);
    expect(out.suggestionsAccepted).toBe(0);
  });

  it("strips a UTF-8 BOM on the header row", () => {
    const csv = "\ufeffuser,active_days\nalice,4\n";
    const out = parseAdoptionCsv(csv);
    expect(out.rows).toBe(1);
    expect(out.activeUsers).toBe(1);
  });

  it("respects quoted fields containing commas", () => {
    const csv = [
      "user,active_days,suggestions_seen,suggestions_accepted",
      '"alice, jr",5,100,40',
    ].join("\n");
    const out = parseAdoptionCsv(csv);
    expect(out.rows).toBe(1);
    expect(out.activeUsers).toBe(1);
    expect(out.suggestionsSeen).toBe(100);
  });

  it("throws on missing required user column", () => {
    expect(() => parseAdoptionCsv("active_days\n5\n")).toThrowError(/user/);
  });

  it("throws on empty input", () => {
    expect(() => parseAdoptionCsv("   \n")).toThrowError(/empty/);
  });
});

describe("computeAdoptionEvidence", () => {
  it("emits a People-dimension gap when activeUsers is unknown", () => {
    const r = computeAdoptionEvidence(null, 80, "Cursor", "active users");
    expect(r.adoptionPct).toBeNull();
    expect(r.evidence.dimension).toBe("people");
    expect(r.evidence.signalType).toBe("gap");
    expect(r.evidence.text).toMatch(/Cursor/);
  });

  it("emits a quote when activeUsers is known but engineerCount is missing", () => {
    const r = computeAdoptionEvidence(40, 0, "Cursor", "active seats");
    expect(r.adoptionPct).toBeNull();
    expect(r.evidence.dimension).toBe("people");
    expect(r.evidence.signalType).toBe("quote");
    expect(r.evidence.text).toMatch(/40 active seats/);
  });

  it("computes adoption percent and tags it as a strength when ≥ 50%", () => {
    const r = computeAdoptionEvidence(60, 80, "Claude Code", "active users");
    expect(r.adoptionPct).toBeCloseTo(75, 5);
    expect(r.evidence.signalType).toBe("strength");
    expect(r.evidence.stageHint).toBe(4);
  });

  it("caps adoption at 100% when activeUsers exceeds engineerCount", () => {
    const r = computeAdoptionEvidence(90, 80, "Cursor", "active users");
    expect(r.adoptionPct).toBe(100);
    expect(r.evidence.stageHint).toBe(5);
  });

  it("tags low adoption as a gap with a low stage hint", () => {
    const r = computeAdoptionEvidence(8, 80, "Windsurf", "active users");
    expect(r.adoptionPct).toBeCloseTo(10, 5);
    expect(r.evidence.signalType).toBe("gap");
    expect(r.evidence.stageHint).toBe(2);
  });
});
