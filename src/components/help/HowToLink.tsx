"use client";

import type { ReactNode } from "react";
import { openHowTo } from "./openHowTo";

/**
 * A link to a help page that opens it in the How to drawer, beside the page
 * you're on. A modified click (new tab) or no drawer goes to the page itself.
 */
export function HowToLink({ path, className, children }: { path: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={path}
      target="_blank"
      rel="noopener"
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (openHowTo(path)) e.preventDefault();
      }}
    >
      {children}
    </a>
  );
}
