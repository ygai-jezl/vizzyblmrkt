import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Invite } from "@/lib/types/invite";
import type { ProductUser } from "@/lib/types/productUser";
import { INVITE_CODE_RE, inviteEmailHash } from "./ids";

/**
 * Invite progress from a connected product's events (nav v2 phase 4), run after
 * each ingest batch.
 *
 * - SIGNED UP: a product user who is new since the invite went out, matched by
 *   the invite code the product passed back (`yg_invite`, as a trait or on
 *   `user.signed_up`), or else by email (a tenant-salted hash; invites keep no
 *   address). Someone who already used the product doesn't count.
 * - ACTIVATED: that same product user activates (see ProductUser.activated).
 *
 * Flags only move forward, so replayed events are harmless. Best-effort: the
 * caller logs a failure and never fails the ingest.
 */

export interface TouchedUser {
  user: ProductUser;
  /** An invite code the product sent back with this message, if any. */
  code: string | null;
}

/** A sign-up counts only if the product user first appeared after (or just before) the invite was sent. */
const NEW_USER_GRACE_MS = 10 * 60_000;
const CHUNK = 30;
const NO_INVITES_MEMO_MS = 60_000;
const noInvitesUntil = new Map<string, number>();

/** The `yg_invite` code a product sent back as a trait (API v2), if it's a well-formed one. */
export function inviteCodeFromTraits(traits: Record<string, unknown> | undefined): string | null {
  const code = traits?.yg_invite;
  return typeof code === "string" && INVITE_CODE_RE.test(code) ? code : null;
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

export async function recordInviteProgress(
  ctx: TenantContext,
  connectionId: string,
  touched: TouchedUser[],
  opts: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<{ signedUp: number; activated: number }> {
  const result = { signedUp: 0, activated: 0 };
  // One entry per user: the newest doc, and any code seen in the batch.
  const byUser = new Map<string, TouchedUser>();
  for (const t of touched) {
    if (t.user.status !== "active") continue;
    const prev = byUser.get(t.user.id);
    byUser.set(t.user.id, { user: t.user, code: t.code ?? prev?.code ?? null });
  }
  if (byUser.size === 0) return result;

  const nowMs = opts.nowMs ?? Date.now();
  const memoKey = `${ctx.tenantId}:${connectionId}`;
  if ((noInvitesUntil.get(memoKey) ?? 0) > nowMs) return result;
  const repos = forTenant(ctx, opts.db);
  const any = await repos.invites.find({ where: [["connectionId", "==", connectionId]], limit: 1 });
  if (any.length === 0) {
    noInvitesUntil.set(memoKey, nowMs + NO_INVITES_MEMO_MS);
    return result;
  }

  const users = [...byUser.values()];
  const matches = new Map<string, { invite: Invite; user: ProductUser; by: "code" | "email" }>();
  // 1. By code (the strongest link).
  const withCode = users.filter((u) => u.code);
  for (const part of chunks(withCode)) {
    const found = await repos.invites.find({
      where: [
        ["connectionId", "==", connectionId],
        ["code", "in", part.map((u) => u.code!)],
      ],
    });
    for (const inv of found) {
      const u = part.find((p) => p.code === inv.code);
      if (u) matches.set(inv.id, { invite: inv, user: u.user, by: "code" });
    }
  }
  // 2. By email, for users the code didn't match.
  const matchedUsers = new Set([...matches.values()].map((m) => m.user.id));
  const byHash = new Map<string, ProductUser>();
  for (const u of users) {
    if (matchedUsers.has(u.user.id) || !u.user.emailNormalized) continue;
    byHash.set(inviteEmailHash(ctx.tenantId, u.user.emailNormalized), u.user);
  }
  for (const part of chunks([...byHash.keys()])) {
    const found = await repos.invites.find({
      where: [
        ["connectionId", "==", connectionId],
        ["emailHash", "in", part],
      ],
    });
    for (const inv of found) {
      const user = byHash.get(inv.emailHash);
      if (user && !matches.has(inv.id)) matches.set(inv.id, { invite: inv, user, by: "email" });
    }
  }

  const now = new Date(nowMs).toISOString();
  for (const { invite, user, by } of matches.values()) {
    if (!invite.invited || invite.signedUp || !invite.invitedAt) continue;
    // When the account was made: the product's own signedUpAt (API v2), else when we first saw them.
    const joinedAt = user.signedUpAt ?? user.firstSeenAt;
    const isNew = Date.parse(joinedAt) >= Date.parse(invite.invitedAt) - NEW_USER_GRACE_MS;
    if (!isNew) continue;
    const done = await repos.invites.claim(invite.id, (cur) =>
      cur.signedUp
        ? null
        : {
            signedUp: true,
            signedUpAt: joinedAt,
            productUserId: user.id,
            matchedBy: by,
            ...(user.activated ? { activated: true, activatedAt: user.activatedAt ?? now } : {}),
            updatedAt: now,
          },
    );
    if (done) {
      result.signedUp += 1;
      if (user.activated) result.activated += 1;
    }
  }

  // 3. Activation that arrives in a later batch than the sign-up.
  const activatedUsers = users.filter((u) => u.user.activated).map((u) => u.user);
  for (const part of chunks(activatedUsers)) {
    const found = await repos.invites.find({
      where: [
        ["productUserId", "in", part.map((u) => u.id)],
        ["activated", "==", false],
      ],
    });
    for (const inv of found) {
      const user = part.find((u) => u.id === inv.productUserId);
      if (!user) continue;
      const done = await repos.invites.claim(inv.id, (cur) =>
        cur.activated || cur.productUserId !== user.id
          ? null
          : { activated: true, activatedAt: user.activatedAt ?? now, updatedAt: now },
      );
      if (done) result.activated += 1;
    }
  }
  return result;
}

/** A wave just created invites for this product: stop skipping it (on this instance). */
export function forgetNoInvites(tenantId: string, connectionId: string): void {
  noInvitesUntil.delete(`${tenantId}:${connectionId}`);
}

/** Tests only: forget the "no invites here" memo. */
export function resetInviteMemo(): void {
  noInvitesUntil.clear();
}
