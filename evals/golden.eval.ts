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

describe("Ask Copper golden set", () => {
  for (const golden of GOLDEN_SET) {
    it(golden.id, { timeout: 120_000 }, async () => {
      const scores = await startActiveObservation(
        `eval:${golden.id}`,
        async (span) => {
          span.update({
            input: golden.question,
            metadata: { run, case: golden.id },
          });
          const { progress } = await askCopper({
            messages: [{ role: "user", content: golden.question }],
            useTools: true,
            desk: golden.desk,
          });
          const final = await finalValue(progress);
          const tools = toolCallsOf(final).map((call) => call.name);
          const verdict = await judge({
            question: golden.question,
            expected: golden.expected,
            answer: final.reply,
          });
          const graded = gradeCase(golden, tools, verdict);
          span.update({
            output: final.reply,
            metadata: { run, case: golden.id, tools, reason: verdict.reason },
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
          return { graded, reason: verdict.reason, answer: final.reply };
        },
      );
      results.push(scores.graded);
      // One miss doesn't fail the run: the pass-rate test below is the gate.
      if (!scores.graded.pass)
        console.warn(
          `[golden] FAILED ${golden.id}: ${scores.reason}\nAnswer: ${scores.answer}`,
        );
    });
  }

  afterAll(async () => {
    const rate = passRate(results);
    console.info(
      `[golden] ${results.filter((r) => r.pass).length}/${GOLDEN_SET.length} passed (${Math.round(rate * 100)}%)`,
    );
    if (langfuse) {
      langfuse.score.create({
        name: "golden.pass_rate",
        value: rate,
        comment: run,
      });
      await langfuse.flush();
    }
    await provider?.forceFlush();
  });

  it(`passes at least ${PASS_THRESHOLD * 100}% of the cases`, () => {
    expect(passRate(results)).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });
});
