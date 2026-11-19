// @vitest-environment node
// The golden-set evaluation: ask Copper every question, have the AI judge
// grade each answer, and send the scores to Langfuse. Run it with
// `npm run evals`. It fails if fewer than PASS_THRESHOLD of the cases pass.
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  gradeCase,
  PASS_THRESHOLD,
  passRate,
  type Scores,
} from "@/evals/grade";
import { GOLDEN_SET } from "@/evals/golden-set";
import { judge } from "@/evals/judge";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import { toolCallsOf } from "@/lib/copper/assistant/progress";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const results: Scores[] = [];
const run = process.env.EVAL_RUN_NAME ?? `golden-${new Date().toISOString()}`;
const langfuseOn = Boolean(
  process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
);

// Send every AI call to Langfuse, and keep a client for the scores.
const { LangfuseClient } = await import("@langfuse/client");
const { startActiveObservation } = await import("@langfuse/tracing");
const langfuse = langfuseOn ? new LangfuseClient() : undefined;
let provider: { forceFlush(): Promise<void> } | undefined;
if (langfuseOn) {
  const { registerTelemetry } = await import("ai");
  const { OpenTelemetry } = await import("@ai-sdk/otel");
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
  const nodeProvider = new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  nodeProvider.register();
  registerTelemetry(new OpenTelemetry());
  provider = nodeProvider;
}

// The free Gemini tier allows only a few requests per minute, so pace the
// cases and retry one that hit the limit instead of grading an error message.
const PACE_MS = Number(process.env.EVAL_PACE_MS ?? 10_000);
const RETRY_WAIT_MS = Number(process.env.EVAL_RETRY_WAIT_MS ?? 30_000);
const ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CaseResult = {
  graded: Scores;
  reason: string;
  answer: string;
  broken: boolean;
};

async function attempt(
  golden: (typeof GOLDEN_SET)[number],
  number: number,
): Promise<CaseResult> {
  return startActiveObservation(`eval:${golden.id}`, async (span) => {
    span.update({
      input: golden.question,
      metadata: { run, case: golden.id, attempt: number },
    });
    const { progress } = await askCopper({
      messages: [{ role: "user", content: golden.question }],
      useTools: true,
      desk: golden.desk,
    });
    const final = await finalValue(progress);
    // An errored answer (usually a rate limit) isn't a bad answer: retry it.
    if (final.status === "error")
      return {
        graded: { correct: 0, safe: 0, tools: 0, pass: 0 },
        reason: "Copper hit an error before it could answer.",
        answer: final.reply,
        broken: true,
      };
    const tools = toolCallsOf(final).map((call) => call.name);
    const verdict = await judge({
      question: golden.question,
      expected: golden.expected,
      answer: final.reply,
    });
    const graded = gradeCase(golden, tools, verdict);
    span.update({
      output: final.reply,
      metadata: {
        run,
        case: golden.id,
        attempt: number,
        tools,
        reason: verdict.reason,
      },
    });
    if (langfuse)
      for (const [name, value] of Object.entries(graded))
        langfuse.score.trace(
          { otelSpan: span.otelSpan },
          {
            name: `golden.${name}`,
            value,
            comment: name === "pass" ? verdict.reason : undefined,
          },
        );
    return {
      graded,
      reason: verdict.reason,
      answer: final.reply,
      broken: false,
    };
  });
}

describe("Ask Copper golden set", () => {
  GOLDEN_SET.forEach((golden, index) => {
    it(golden.id, { timeout: 300_000 }, async () => {
      if (index > 0) await sleep(PACE_MS);
      let result: CaseResult | undefined;
      for (let n = 1; n <= ATTEMPTS; n++) {
        try {
          result = await attempt(golden, n);
        } catch (error) {
          result = {
            graded: { correct: 0, safe: 0, tools: 0, pass: 0 },
            reason: `The call failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
            answer: "",
            broken: true,
          };
        }
        if (!result.broken) break;
        if (n < ATTEMPTS) await sleep(RETRY_WAIT_MS);
      }
      const final = result!;
      results.push(final.graded);
      // One miss doesn't fail the run: the pass-rate test below is the gate.
      if (!final.graded.pass)
        console.warn(
          `[golden] FAILED ${golden.id}: ${final.reason}\nAnswer: ${final.answer}`,
        );
    });
  });

  afterAll(async () => {
    const rate = passRate(results);
    console.info(
      `[golden] ${results.filter((r) => r.pass).length}/${GOLDEN_SET.length} passed (${Math.round(rate * 100)}%)`,
    );
    if (langfuse) {
      // Scores need a trace to attach to, so each run gets a summary trace.
      await startActiveObservation(`eval-run:${run}`, async (span) => {
        span.update({
          metadata: { run, cases: GOLDEN_SET.length },
          output: `${results.filter((r) => r.pass).length}/${GOLDEN_SET.length} passed`,
        });
        langfuse.score.trace(
          { otelSpan: span.otelSpan },
          { name: "golden.pass_rate", value: rate, comment: run },
        );
      });
      await langfuse.flush();
    }
    await provider?.forceFlush();
  });

  it(`passes at least ${PASS_THRESHOLD * 100}% of the cases`, () => {
    expect(passRate(results)).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });
});
