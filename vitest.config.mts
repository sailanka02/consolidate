import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: { "server-only": r("./tests/stubs/server-only.ts"), "@": r("./") } },
  // The pre-existing engine tests exercise the optimized path on tiny fake conversations; margin 0 keeps the cost-aware bypass out of
  // their way. tests/economics.test.ts sets the real margin explicitly.
  test: { include: ["tests/**/*.test.{ts,tsx}"], environment: "node", env: { CONSOLIDATE_ECONOMICS_MARGIN: "0" } },
});
