"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { leftBySoftNavigation } from "@/lib/onboarding/voice/transcript";

const WELCOME_PATH = "/admin/welcome";

/**
 * The microphone is allowed on /admin/welcome's own document only (next.config.ts), and the
 * browser keeps a document's header for every page shown in it after a soft navigation. The
 * welcome's own ways out are whole page loads; this catches the rest (⌘K, Back, any link): when
 * the document is still the welcome's and the page shown is another, it loads that page once more,
 * so it gets its own header (no microphone). The new document's entry names the page shown, so
 * this happens once. Renders nothing.
 */
export function LeaveWelcomeByLoad() {
  const pathname = usePathname();
  useEffect(() => {
    try {
      const entry = performance.getEntriesByType("navigation")[0];
      if (leftBySoftNavigation(entry?.name, pathname, WELCOME_PATH)) window.location.replace(window.location.href);
    } catch {
      /* no navigation entry: leave it */
    }
  }, [pathname]);
  return null;
}
