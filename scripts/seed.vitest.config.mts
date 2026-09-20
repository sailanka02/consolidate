import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// Separate from the test config on purpose: this never runs with `npm test`.
export default defineConfig({
  resolve: { alias: { "server-only": r("../tests/stubs/server-only.ts"), "@": r("../") } },
  test: { include: ["scripts/seed-demos.seed.ts"], environment: "node", testTimeout: 3_600_000, hookTimeout: 3_600_000 },
});
