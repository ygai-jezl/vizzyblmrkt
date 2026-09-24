import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import { hasValidSignupUrl } from "./eligibility";
import { verifyInviteToken } from "./token";

/**
 * What happens when someone clicks an invite link (`/invite/<token>`, nav v2
 * phase 4). Public and unauthenticated, so:
 *
 * - rate-limited per IP, and every token's signature is checked;
 * - the redirect target is the product's SAVED sign-up URL (never anything from
 *   the link), with only `yg_invite=<code>` added — no email, name or tenant id;
 * - HEAD requests (link scanners, previews) change nothing;
 * - it works whatever the invite flags say, so links already sent never break.
 *
 * The route adds `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
 */

export type InviteClickResult =
  | { kind: "redirect"; location: string }
  | { kind: "page"; status: 404 | 410 | 429 | 503; title: string; message: string; productUrl?: string | null };

export interface InviteClickDeps {
  db?: FirestoreLike;
  now?: number;
  rateLimited?: (subject: string) => Promise<boolean>;
  tenantById?: typeof getTenantById;
}

const INVALID: InviteClickResult = {
  kind: "page",
  status: 404,
  title: "This invite link isn't valid",
  message: "Check you copied the whole link from your invite email.",
};

export async function handleInviteClick(
  token: string,
  req: { method: string; ip: string },
  deps: InviteClickDeps = {},
): Promise<InviteClickResult> {
  const limited = deps.rateLimited ?? ((subject: string) =>
    isRateLimited(subject, { prefix: "invite_click", burstLimit: 30, hourlyLimit: 300 }));
  if (await limited(`ip:${req.ip}`)) {
    return { kind: "page", status: 429, title: "Too many requests", message: "Please try again in a minute." };
  }
  const now = deps.now ?? Date.now();
  const verified = verifyInviteToken(token, now);
  if (!verified.ok) return INVALID;

  const tenant = await (deps.tenantById ?? getTenantById)(verified.claims.t).catch(() => null);
  if (!tenant) return INVALID;
  const ctx: TenantContext = { tenantId: tenant.id, region: tenant.region, source: "system" };
  const repos = forTenant(ctx, deps.db);
  const invite = await repos.invites.getById(verified.claims.i);
  if (!invite || invite.status === "cancelled") {
    return {
      kind: "page",
      status: 410,
      title: "This invite is no longer available",
      message: "It may have been withdrawn. Reply to your invite email if you think that's a mistake.",
    };
  }
  const connection = await repos.productConnections.getById(invite.connectionId);
  if (!connection || connection.status !== "active" || !hasValidSignupUrl(connection)) {
    return {
      kind: "page",
      status: 503,
      title: "Invites are paused",
      message: "Sign-ups are paused for a moment. Please try your link again later.",
    };
  }
  if (verified.expired) {
    // Still send them to the product, without the code; a sign-up with the same
    // email is still matched to the invite.
    return {
      kind: "page",
      status: 410,
      title: "This invite has expired",
      message: "You can still sign up with the email address the invite was sent to.",
      productUrl: connection.signupUrl ?? null,
    };
  }

  if (req.method !== "HEAD") {
    const at = new Date(now).toISOString();
    await repos.invites
      .claim(invite.id, (cur) => ({
        clicked: true,
        clickedAt: cur.clickedAt ?? at,
        clickCount: Math.min((cur.clickCount ?? 0) + 1, 1000),
        updatedAt: at,
      }))
      .catch((e) => console.warn(`[invites] click ${invite.id} not recorded:`, e));
  }
  const location = new URL(connection.signupUrl!);
  location.searchParams.set("yg_invite", invite.code);
  return { kind: "redirect", location: location.toString() };
}
