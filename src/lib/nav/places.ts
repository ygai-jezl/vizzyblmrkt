import { isNavV2Phase3Enabled } from "./flags";

/**
 * Where things live, in the words the admin sees. Nav v2 phase 3 renamed the
 * Settings tabs (Domains → Sending, Connections → Integrations) and made the
 * Brand Kit "Brand", so copy that points people somewhere uses these.
 */
export type Place = "sending" | "integrations" | "logos";

export function place(key: Place): { label: string; href: string } {
  const p3 = isNavV2Phase3Enabled();
  switch (key) {
    case "sending":
      return { label: p3 ? "Settings › Sending" : "Account → Domains", href: "/admin/account" };
    case "integrations":
      return { label: p3 ? "Settings › Integrations" : "Account → Connections", href: "/admin/account/connections" };
    case "logos":
      return { label: p3 ? "Brand › Logos" : "Brand Kit → Logos", href: "/admin/brand-kit/logos" };
  }
}
