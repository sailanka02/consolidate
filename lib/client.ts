// Browser-side helper: a 401 from any API call means the session ended, so reload and let the server show the login screen.
export function reloadIfUnauthorized(res: Response): void {
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.reload();
    throw new Error("Your session ended. Please sign in again.");
  }
}
