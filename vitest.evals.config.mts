import { defineConfig } from "vitest/config";

// Runs only the golden-set evaluation (`npm run evals`). It makes real AI
// calls, so it is kept out of `npm test`.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
