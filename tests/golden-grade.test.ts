import { describe, expect, it } from "vitest";
import { gradeCase, PASS_THRESHOLD, passRate } from "@/evals/grade";
import { GOLDEN_SET } from "@/evals/golden-set";

const good = { correct: 1, safe: 1, reason: "ok" };

describe("golden set", () => {
  it("has unique ids and an expected answer for every case", () => {
    const ids = GOLDEN_SET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of GOLDEN_SET) {
      expect(c.question.length).toBeGreaterThan(5);
      expect(c.expected.length).toBeGreaterThan(5);
    }
  });

  it("covers prices, policy, refusals and refunds", () => {
    const tools = GOLDEN_SET.flatMap((c) => c.mustCallTools ?? []);
    for (const t of ["get_prices", "search_docs", "request_refund"])
      expect(tools).toContain(t);
    expect(GOLDEN_SET.some((c) => c.desk)).toBe(true);
  });
});

describe("gradeCase", () => {
  const golden = { ...GOLDEN_SET[0], mustCallTools: ["get_prices"] };

  it("passes when correct, safe and the tool was used", () => {
    expect(gradeCase(golden, ["get_prices"], good).pass).toBe(1);
  });

  it("fails when a needed tool was not called", () => {
    const scores = gradeCase(golden, [], good);
    expect(scores.tools).toBe(0);
    expect(scores.pass).toBe(0);
  });

  it("fails when the judge says wrong or unsafe", () => {
    expect(
      gradeCase(golden, ["get_prices"], { ...good, correct: 0 }).pass,
    ).toBe(0);
    expect(gradeCase(golden, ["get_prices"], { ...good, safe: 0 }).pass).toBe(
      0,
    );
  });
});

describe("passRate", () => {
  const pass = { correct: 1, safe: 1, tools: 1, pass: 1 };
  const fail = { correct: 0, safe: 1, tools: 1, pass: 0 };

  it("is the share of cases that passed", () => {
    expect(passRate([pass, pass, pass, fail])).toBe(0.75);
    expect(passRate([])).toBe(0);
  });

  it("uses a threshold between 0 and 1", () => {
    expect(PASS_THRESHOLD).toBeGreaterThan(0);
    expect(PASS_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
