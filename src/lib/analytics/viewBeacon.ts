/**
 * Client-side widget-view beacon. Fires once per embedded-widget render to
 * record an impression — the only signal that captures viewers who never sign
 * up (PRD §4.2 "Views over Time" / "Referrer Sources").
 *
 * No-op unless NEXT_PUBLIC_ANALYTICS_BQ_ENABLED is "true" (so it tree-shakes to
 * nothing when the pipeline is off). Posts SAME-ORIGIN to /api/track/view (the
 * iframe is served from our origin) so there is no CORS/preflight. Uses
 * navigator.sendBeacon (fire-and-forget, survives unload) with a keepalive fetch
 * fallback. Never throws — a telemetry beacon must never break the widget.
 *
 * UTM + referrer come from the iframe's OWN URL + document.referrer: the embed
 * loader (embed.js) copies the host page's utm_* params onto the iframe src, and
 * an iframe's document.referrer is the embedding (host) page — exactly the
 * attribution we want, without the framed doc needing to read the parent's URL.
 */
export function sendViewBeacon(campaignId: string): void {
  if (process.env.NEXT_PUBLIC_ANALYTICS_BQ_ENABLED !== "true") return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  try {
    const sp = new URLSearchParams(window.location.search);
    const body = JSON.stringify({
      campaignId,
      // Tenant routing hint (shared-host); omitted on custom domains (undefined
      // is dropped by JSON.stringify → server falls back to origin resolution).
      t: sp.get("t") ?? undefined,
      ref: document.referrer || undefined,
      // The client's own UA — App Hosting's edge rewrites the request User-Agent
      // header to "Google" at the origin, so the server can't read it from
      // headers. Sent here so the server can classify real browsers vs bots
      // (only the bucketed class is stored, never this raw string).
      ua: navigator.userAgent || undefined,
      utm: {
        source: sp.get("utm_source") ?? undefined,
        medium: sp.get("utm_medium") ?? undefined,
        campaign: sp.get("utm_campaign") ?? undefined,
        content: sp.get("utm_content") ?? undefined,
        term: sp.get("utm_term") ?? undefined,
      },
    });
    const url = "/api/track/view";
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    } else if (typeof fetch === "function") {
      void fetch(url, {
        method: "POST",
        body,
        keepalive: true,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch {
    /* never throw from a beacon */
  }
}
