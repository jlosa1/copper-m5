// @vitest-environment node
// The golden-set evaluation, run on two designs of the same support agent:
//   multi:  Copper and the Refund agent, with handoffs (what the app ships)
//   single: one agent with every tool and no handoff
// Each question is asked of both, the AI judge grades each answer, and the
// scores, cost and time go to Langfuse tagged with the design. Run it with
// `npm run evals`. The run fails if the two-agent design (the one that ships)
// passes fewer than PASS_THRESHOLD of the cases. The single agent is
// measured and reported, not gated.
import { appendFileSync, existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  gradeCase,
  PASS_THRESHOLD,
  passRate,
  type Scores,
} from "@/evals/grade";
import { GOLDEN_SET, type GoldenCase } from "@/evals/golden-set";
import { judge } from "@/evals/judge";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import { DEFAULT_LIMIT_USD, type Desk } from "@/lib/copper/orders";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

type Variant = "multi" | "single";
const VARIANTS = (process.env.EVAL_VARIANTS ?? "multi,single")
  .split(",")
  .filter((v): v is Variant => v === "multi" || v === "single");

// EVAL_ONLY=<case id> runs just that question. EVAL_SHARE=<case id> also makes
// that case's trace public in Langfuse (multi design) and writes its link to
// EVAL_SHARE_FILE, so one conversation can be shared. Both are off in CI.
const ONLY = process.env.EVAL_ONLY;
const SHARE = process.env.EVAL_SHARE;

const run = process.env.EVAL_RUN_NAME ?? `golden-${new Date().toISOString()}`;
const langfuseOn = Boolean(
  process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
);

// Both designs are tested as they run on the Support page, with the Refund
// Console's desk, so the only difference between them is the design.
const DESK: Desk = { limitUsd: DEFAULT_LIMIT_USD, refunds: [] };

// Send every AI call to Langfuse, and keep a client for the scores.
const { LangfuseClient } = await import("@langfuse/client");
const { startActiveObservation, setActiveTraceAsPublic, getActiveTraceId } =
  await import("@langfuse/tracing");
const langfuse = langfuseOn ? new LangfuseClient() : undefined;
let provider: { forceFlush(): Promise<void> } | undefined;
if (langfuseOn) {
  const { registerTelemetry } = await import("ai");
  const { OpenTelemetry } = await import("@ai-sdk/otel");
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
  // Name the service, or it is named after the path of the node program.
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const nodeProvider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "copper-state-labs-evals",
    }),
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  nodeProvider.register();
  registerTelemetry(new OpenTelemetry());
  provider = nodeProvider;
}

// Cost and tokens per case, read from the [ai_calls] lines lib/ai/call.ts
// prints. The judge's own calls are left out: they aren't part of the agent.
type CallRow = {
  feature: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
};
let captured: CallRow[] = [];
const originalInfo = console.info.bind(console);
console.info = (...args: unknown[]) => {
  if (args[0] === "[ai_calls]" && typeof args[1] === "string") {
    try {
      captured.push(JSON.parse(args[1]) as CallRow);
    } catch {
      // not JSON: ignore
    }
  }
  originalInfo(...args);
};

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
  latencyS: number;
  costUsd: number;
  tokens: number;
};

type Totals = { scores: Scores[]; results: CaseResult[] };
const totals: Record<Variant, Totals> = {
  multi: { scores: [], results: [] },
  single: { scores: [], results: [] },
};

const BROKEN: Omit<CaseResult, "reason" | "answer"> = {
  graded: { correct: 0, safe: 0, tools: 0, pass: 0 },
  broken: true,
  latencyS: 0,
  costUsd: 0,
  tokens: 0,
};

/** The single agent has no handoff tool, so don't require one of it. */
function forVariant(golden: GoldenCase, variant: Variant): GoldenCase {
  if (variant === "multi") return golden;
  return {
    ...golden,
    mustCallTools: golden.mustCallTools?.filter(
      (name) => !name.startsWith("transfer_"),
    ),
  };
}

async function attempt(
  golden: GoldenCase,
  variant: Variant,
  number: number,
): Promise<CaseResult> {
  return startActiveObservation(
    `eval:${variant}:${golden.id}`,
    async (span) => {
      span.otelSpan.setAttribute("langfuse.trace.tags", [variant, "golden"]);
      span.otelSpan.setAttribute("langfuse.session.id", run);
      span.update({
        input: golden.question,
        metadata: { run, case: golden.id, variant, attempt: number },
      });
      if (SHARE === golden.id && variant === "multi") {
        setActiveTraceAsPublic();
        const traceId = getActiveTraceId();
        if (traceId && process.env.EVAL_SHARE_FILE)
          appendFileSync(process.env.EVAL_SHARE_FILE, `${traceId}\n`);
      }
      captured = [];
      const started = performance.now();
      const { progress } = await askCopper({
        messages: [{ role: "user", content: golden.question }],
        useTools: true,
        desk: golden.desk ?? DESK,
        mode: variant,
      });
      const final = await finalValue(progress);
      const latencyS = (performance.now() - started) / 1000;
      const agentCalls = captured.filter((c) => c.feature !== "eval-judge");
      const costUsd = agentCalls.reduce((n, c) => n + (c.cost_usd ?? 0), 0);
      const tokens = agentCalls.reduce(
        (n, c) => n + (c.input_tokens ?? 0) + (c.output_tokens ?? 0),
        0,
      );
      // An errored answer (usually a rate limit) isn't a bad answer: retry it.
      if (final.status === "error")
        return {
          ...BROKEN,
          reason: "The agent hit an error before it could answer.",
          answer: final.reply,
        };
      const toolsCalled = toolCallsOf(final).map((call) => call.name);
      const verdict = await judge({
        question: golden.question,
        expected: golden.expected,
        answer: final.reply,
      });
      const graded = gradeCase(
        forVariant(golden, variant),
        toolsCalled,
        verdict,
      );
      span.update({
        output: final.reply,
        metadata: {
          run,
          case: golden.id,
          variant,
          attempt: number,
          tools: toolsCalled,
          reason: verdict.reason,
        },
      });
      if (langfuse) {
        const scores = {
          ...graded,
          cost_usd: costUsd,
          latency_s: latencyS,
        };
        for (const [name, value] of Object.entries(scores))
          langfuse.score.trace(
            { otelSpan: span.otelSpan },
            {
              name: `golden.${name}`,
              value,
              comment: name === "pass" ? verdict.reason : undefined,
            },
          );
      }
      return {
        graded,
        reason: verdict.reason,
        answer: final.reply,
        broken: false,
        latencyS,
        costUsd,
        tokens,
      };
    },
  );
}

for (const variant of VARIANTS) {
  describe(`Ask Copper golden set: ${variant} agent`, () => {
    GOLDEN_SET.filter((g) => !ONLY || g.id === ONLY).forEach(
      (golden, index) => {
        it(golden.id, { timeout: 300_000 }, async () => {
          if (index > 0) await sleep(PACE_MS);
          let result: CaseResult | undefined;
          for (let n = 1; n <= ATTEMPTS; n++) {
            try {
              result = await attempt(golden, variant, n);
            } catch (error) {
              result = {
                ...BROKEN,
                reason: `The call failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
                answer: "",
              };
            }
            if (!result.broken) break;
            if (n < ATTEMPTS) await sleep(RETRY_WAIT_MS);
          }
          const final = result!;
          totals[variant].scores.push(final.graded);
          totals[variant].results.push(final);
          // One miss doesn't fail the run: the pass-rate test is the gate.
          if (!final.graded.pass)
            console.warn(
              `[golden] FAILED ${variant}/${golden.id}: ${final.reason}\nAnswer: ${final.answer}`,
            );
        });
      },
    );
  });
}

function summarize(variant: Variant) {
  const { scores, results } = totals[variant];
  const n = results.length || 1;
  return {
    variant,
    passed: scores.filter((s) => s.pass).length,
    cases: results.length,
    passRate: passRate(scores),
    avgLatencyS: results.reduce((x, r) => x + r.latencyS, 0) / n,
    totalCostUsd: results.reduce((x, r) => x + r.costUsd, 0),
    avgTokens: results.reduce((x, r) => x + r.tokens, 0) / n,
  };
}

describe("Single agent vs two agents", () => {
  afterAll(async () => {
    const rows = VARIANTS.map(summarize);
    const lines = [
      "| Design | Passed | Pass rate | Avg time | Total cost | Avg tokens |",
      "|---|---|---|---|---|---|",
      ...rows.map(
        (r) =>
          `| ${r.variant === "multi" ? "Two agents (Copper + Refund)" : "Single agent"} | ${r.passed}/${r.cases} | ${Math.round(r.passRate * 100)}% | ${r.avgLatencyS.toFixed(1)}s | $${r.totalCostUsd.toFixed(4)} | ${Math.round(r.avgTokens)} |`,
      ),
    ];
    console.info(`[golden] comparison\n${lines.join("\n")}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Golden set: single agent vs two agents\n\n${lines.join("\n")}\n`,
      );
    if (langfuse) {
      for (const r of rows)
        // Scores need a trace to attach to, so each design gets a summary trace.
        await startActiveObservation(
          `eval-run:${r.variant}:${run}`,
          async (span) => {
            span.otelSpan.setAttribute("langfuse.trace.tags", [
              r.variant,
              "golden-summary",
            ]);
            span.otelSpan.setAttribute("langfuse.session.id", run);
            span.update({
              metadata: { run, variant: r.variant, cases: r.cases },
              output: `${r.passed}/${r.cases} passed`,
            });
            for (const [name, value] of Object.entries({
              pass_rate: r.passRate,
              avg_latency_s: r.avgLatencyS,
              total_cost_usd: r.totalCostUsd,
              avg_tokens: r.avgTokens,
            }))
              langfuse.score.trace(
                { otelSpan: span.otelSpan },
                {
                  name: `golden.${name}`,
                  value,
                  comment: `${r.variant} ${run}`,
                },
              );
          },
        );
      await langfuse.flush();
    }
    await provider?.forceFlush();
  });

  it(`the two-agent design passes at least ${PASS_THRESHOLD * 100}% of the cases`, () => {
    if (!VARIANTS.includes("multi")) return;
    expect(passRate(totals.multi.scores)).toBeGreaterThanOrEqual(
      PASS_THRESHOLD,
    );
  });
});
