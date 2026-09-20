// Runs once when the server starts, before it accepts traffic. The Node-only work lives in its own module so the Edge
// analysis of this file stays clean (the documented pattern).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateStartup } = await import("./instrumentation-node");
    validateStartup();
  }
}
