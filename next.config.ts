import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // firebase-admin is server-only; never bundle it for the browser.
  serverExternalPackages: ["firebase-admin"],
  // Security headers applied to every response. The public landing pages and
  // the admin portal both inherit these baseline protections.
  async headers() {
    const baseline = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Keep the opener handle to popups we open so Firebase Auth's
      // signInWithPopup can poll popup.closed without the browser blocking the
      // call (the repeated "Cross-Origin-Opener-Policy would block the
      // window.closed call" console warnings). Ignored for iframed documents,
      // so it leaves the framable /embed widget unaffected.
      { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      },
    ];
    // Permissions-Policy is per-surface: only the public waitlist pages and the
    // embeddable widget may use the microphone (the optional Gemini Live voice
    // conversation). Everything else keeps it disabled. Sources below are
    // mutually exclusive so a single Permissions-Policy lands on every route
    // (no duplicate/conflicting header).
    const noDevices = {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    };
    const micSelf = {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(self), geolocation=()",
    };
    const lockedFrame = [
      { key: "X-Frame-Options", value: "DENY" },
      // Baseline CSP. A full nonce-based default-src/script-src policy lands in
      // Phase 1. No connect-src directive → the wss://generativelanguage.googleapis.com
      // Live connection is permitted; add connect-src for *.googleapis.com if a
      // stricter CSP is introduced.
      {
        key: "Content-Security-Policy",
        value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
      },
    ];
    return [
      {
        // Public hosted waitlist pages — mic enabled for the voice conversation.
        source: "/waitlist/:path*",
        headers: [...baseline, ...lockedFrame, micSelf],
      },
      {
        // Admin-only live preview for the Embed & Design builder. Same-origin
        // framable (the builder iframes it); X-Frame-Options SAMEORIGIN + CSP
        // frame-ancestors 'self'. Free-text branding params are safe here because
        // the route is admin-gated (requireAdminContext) — unlike the public
        // /embed route. Lives outside /admin so the frame is free of admin chrome.
        source: "/admin-preview/:campaignId",
        headers: [
          ...baseline,
          noDevices,
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
          },
        ],
      },
      {
        // Every route EXCEPT the embed widget, the waitlist pages, and the admin
        // preview frame (all handled above). The negative lookahead also skips
        // /embed.js.
        source: "/((?!embed|waitlist|admin-preview/[^/]+).*)",
        headers: [...baseline, ...lockedFrame, noDevices],
      },
      {
        // The embeddable widget must be framable on any customer site. It only
        // exposes what is already public on /waitlist/<id>, and the write path
        // is guarded by reCAPTCHA + double opt-in. X-Frame-Options is dropped
        // (it cannot express an allow-any), leaving CSP frame-ancestors to do
        // the work.
        // TODO(later, gated on real third-party tenants): replace `*` with a
        // per-tenant embed allowlist. NOT tenant.allowedOrigins (those are the
        // tenant's own Host-routing domains) — needs a dedicated field + Node
        // middleware (this headers() block is static). See DECISIONS.md "Open
        // items carried forward" and SETUP §12.
        source: "/embed/:path*",
        headers: [
          ...baseline,
          // microphone=(self) so the post-signup Gemini Live voice conversation
          // works inside the framed widget. (self) permits only the embed's own
          // origin — the parent still has to delegate via the iframe `allow`
          // attribute in /embed.js, and the customer's host page must itself
          // permit the mic. Server-side the conversation stays feature-gated on
          // campaign.aiConversation.enabled (conversation/token route).
          micSelf,
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors *; object-src 'none'; base-uri 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
