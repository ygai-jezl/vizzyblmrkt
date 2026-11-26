import type { WeekPoint } from "@/lib/insights/overview";
import type { TenantContext } from "@/lib/tenant/types";
import type { MetricBlock, Slide } from "../types";

/** Made up brands and people for the Raise kit's tests: Acme (a startup) and Fernhill Plants (a shop). */

export const NOW = new Date("2026-11-26T10:00:00.000Z");
export const ACME: TenantContext = { tenantId: "ten_acme", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
export const ACME_MEMBER: TenantContext = { ...ACME, userId: "usr_member", role: "member" };
export const FERNHILL: TenantContext = { tenantId: "ten_fernhill", region: "eu", source: "idtoken", userId: "usr_fern", role: "admin" };

/** Twelve rolling weeks ending at `now`, oldest first, with these counts (null: a failed read). */
export function weeksOf(values: Array<number | null>, now: Date = NOW): WeekPoint[] {
  const DAY = 86_400_000;
  return values.map((signups, i) => {
    const end = new Date(now.getTime() - (values.length - 1 - i) * 7 * DAY);
    return { start: new Date(end.getTime() - 7 * DAY).toISOString().slice(0, 10), signups };
  });
}

export function block(over: Partial<MetricBlock> = {}): MetricBlock {
  return {
    id: "mb_aaaaaaaa",
    meaning: "waitlistSignups",
    grain: "total",
    weeks: 12,
    name: "Sign-ups to your launches",
    value: 4310,
    unit: "count",
    display: "4,310",
    periodWords: "12 weeks to 26 Nov",
    source: { kind: "insights" },
    asOf: NOW.toISOString(),
    ...over,
  };
}

let n = 0;
export function slide(over: Partial<Slide> = {}): Slide {
  n += 1;
  return {
    id: `sl_${String(n).padStart(8, "0")}`,
    section: "problem",
    layout: "statement",
    headline: "Shop owners lose a day a week to stock counts",
    points: [],
    blocks: [],
    notes: "",
    needs: [],
    sources: [],
    ...over,
  };
}

/** A pre-seed deck's sections with a plain headline each. */
export function preSeedSlides(): Slide[] {
  const sections = ["cover", "problem", "solution", "traction", "why_now", "market", "competition", "business_model", "team", "ask"] as const;
  return sections.map((section) => slide({ section, headline: section === "cover" ? "Acme" : `Acme makes ${section.replace(/_/g, " ")} simple for small teams` }));
}
