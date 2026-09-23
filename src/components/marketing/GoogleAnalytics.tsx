"use client";

import { useEffect } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { gaBootstrapScript, gaConfig, isGaTrackedPath } from "@/lib/analytics/googleAnalytics";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * GA4 on the public site (see src/lib/analytics/googleAnalytics.ts). Rendered in
 * the root layout; loads gtag.js on the first tracked page. Enhanced measurement
 * then records client-side navigations, so off-scope routes set Google's
 * `ga-disable-<ID>` opt-out to stop hits there. Caveat: Next pushes the new URL
 * before any effect runs, so a client-side hop from a public page into /admin
 * (e.g. after sign-in) may still record that one page_view — the path only.
 */
export function GoogleAnalytics() {
  const pathname = usePathname();
  const config = gaConfig();
  const measurementId = config?.measurementId;
  const tracked = config !== null && isGaTrackedPath(pathname);

  useEffect(() => {
    if (!measurementId) return;
    (window as unknown as Record<string, unknown>)[`ga-disable-${measurementId}`] = !tracked;
  }, [measurementId, tracked]);

  // The homepage waitlist is our own /embed widget; embed.js re-dispatches its
  // signup on this window. The detail carries no personal data.
  useEffect(() => {
    if (!tracked) return;
    const onSignup = (e: Event) => {
      if ((e as CustomEvent<{ alreadyJoined?: boolean }>).detail?.alreadyJoined) return;
      window.gtag?.("event", "sign_up", { method: "waitlist" });
    };
    window.addEventListener("vizzybl:signup", onSignup);
    return () => window.removeEventListener("vizzybl:signup", onSignup);
  }, [tracked]);

  if (!config || !tracked) return null;
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${config.measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="ga-bootstrap" strategy="afterInteractive">
        {gaBootstrapScript(config)}
      </Script>
    </>
  );
}
