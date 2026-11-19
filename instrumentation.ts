// Runs once when the server starts. Sends a trace of every AI call (the agent,
// its tool calls, tokens, cost and time) to Langfuse. Without the Langfuse keys
// in .env.local nothing is sent and the app works as before.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)
    return;

  const { registerTelemetry } = await import("ai");
  const { OpenTelemetry } = await import("@ai-sdk/otel");
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  const { NodeTracerProvider } = await import(
    "@opentelemetry/sdk-trace-node"
  );

  const provider = new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  provider.register();
  registerTelemetry(new OpenTelemetry());
}
