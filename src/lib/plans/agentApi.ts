import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { meaningsOf, numberKeys } from "@/lib/metrics/meanings";
import { isRateLimited, type TenantContext } from "@/lib/tenant";
import { isUsageMeterEnabled } from "./flags";
import { PURPOSE_LABELS, type ResourcePurpose } from "./resources";
import { organisationUsage, type MonthlyRow, type UsageDeps, type UsageSummary } from "./usage";

/**
 * For Vizzy's get_usage (/api/agent/usage, USAGE_METER_ENABLED): what this brand used this month
 * of each paid resource and costly feature, against its limit, by the feature that used it, and,
 * for an organisation's owners, the organisation's totals. The same figures as Plan and usage,
 * with the meaning of every number. Read only; the brand comes from the signed canvas token.
 */

export type ApiResult = { status: number; body: unknown };

const LIMIT = { prefix: "usage_agent", burstLimit: 10, hourlyLimit: 120 };

export const NOTE =
  "Counts run from the 1st of the month (UTC). A null monthlyLimit means no limit. AI model use counts the tokens of every Gemini call the app makes for this brand, Vizzy's chat included; " +
  "it doesn't count the Memory Bank's own model or the browser voice chat. To change a limit or plan, ask whoever runs this copy of YouGrow.";

export async function usageAgentGate(req: Request): Promise<{ ok: true; ctx: TenantContext } | { ok: false; result: ApiResult }> {
  if (!isUsageMeterEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  const ctx = tenantContextFromCanvasToken(verified.claims);
  if (await isRateLimited(`tenant:${ctx.tenantId}`, LIMIT)) return { ok: false, result: { status: 429, body: { error: "rate_limited" } } };
  return { ok: true, ctx };
}

/** A month's row for an agent: its own number names, so every number has a meaning, and no map of numbers by key. */
function rowForAgent(row: MonthlyRow) {
  const left = row.used !== null && row.limit !== null ? Math.max(0, row.limit - row.used) : null;
  return {
    key: row.feature,
    label: row.label,
    ...(row.unit ? { unit: row.unit } : {}),
    included: row.included,
    usedThisMonth: row.used,
    monthlyLimit: row.limit,
    leftThisMonth: left,
    byFeature: Object.entries(row.byPurpose ?? {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => ({ feature: PURPOSE_LABELS[p as ResourcePurpose] ?? p, usedThisMonth: n })),
    ...(row.byModel
      ? {
          byModel: Object.entries(row.byModel)
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([model, n]) => ({ model, usedThisMonth: n })),
        }
      : {}),
  };
}

export async function agentUsage(ctx: TenantContext, deps: UsageDeps & { summary?: (ctx: TenantContext) => Promise<UsageSummary> } = {}): Promise<ApiResult> {
  const summary = await (deps.summary ?? ((c) => organisationUsage(c, deps)))(ctx);
  const body = {
    month: summary.month,
    plan: summary.plan,
    thisBrand: summary.monthly.map(rowForAgent),
    ...(summary.organisationResources
      ? {
          organisation: {
            name: summary.organisation?.name ?? null,
            brandNames: (summary.brands ?? []).map((b) => b.name),
            thisMonth: summary.organisationResources.map((r) => ({ key: r.resource, label: r.label, unit: r.unit, usedThisMonth: r.used })),
          },
        }
      : {}),
    note: NOTE,
  };
  return { status: 200, body: { ...body, meanings: meaningsOf(numberKeys(body)) } };
}
