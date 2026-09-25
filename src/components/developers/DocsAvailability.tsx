"use client";

import { createContext, useContext, type ReactNode } from "react";

/** Whether this YouGrow publishes /developers — so admin screens only link to docs that exist. */
const DocsContext = createContext(true);

export function DeveloperDocsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <DocsContext.Provider value={enabled}>{children}</DocsContext.Provider>;
}

export function useDeveloperDocs(): boolean {
  return useContext(DocsContext);
}
