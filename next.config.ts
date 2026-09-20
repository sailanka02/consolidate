import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }, { key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "same-origin" }] },
      // Conversations, traces and dashboard numbers must never be cached by a browser or proxy.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
