import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // firebase-admin is server-only; never bundle it for the browser.
  serverExternalPackages: ["firebase-admin"],
  // Security headers applied to every response. The public landing pages and
  // the admin portal both inherit these baseline protections.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          // Baseline CSP. A full nonce-based default-src/script-src policy lands
          // in Phase 1. The embeddable widget route will override frame-ancestors
          // per tenant (from the tenant's allowedOrigins) and drop X-Frame-Options.
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
