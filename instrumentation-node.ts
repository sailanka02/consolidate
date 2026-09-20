// A misconfigured production deployment (wrong provider, missing key/password, database not on the persistent volume)
// stops here with a clear message that names the variables involved and never prints a secret value, so the platform
// reports a failed deploy instead of serving a half-working app. Outside production this does nothing.
import { productionConfigIssues } from "./lib/runtime-config";

export function validateStartup(): void {
  const issues = productionConfigIssues();
  if (issues.length) {
    console.error(`\nConsolidate cannot start: it is misconfigured for production.\n - ${issues.join("\n - ")}\n`);
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" && process.env.CONSOLIDATE_DEV_TOOLS === "1") {
    console.warn("CONSOLIDATE_DEV_TOOLS is set but developer tools are always disabled in production.");
  }
}
