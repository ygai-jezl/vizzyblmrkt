import { z } from "zod";
import { forTenant, getTenantById } from "@/lib/tenant";
import { TenantIsolationError } from "@/lib/tenant/errors";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { Signup } from "@/lib/types/signup";
import { INVITE_LIMITS, type Invite, type InviteWave } from "@/lib/types/invite";
import { rankedSignups } from "@/lib/waitlist/rank";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { enqueueEmailJob } from "@/lib/email/jobs";
import { processEmailJobs } from "@/lib/email/delivery";
import { emailLinkOrigin } from "@/lib/email/footer";
import { resolveCampaignLocale } from "@/lib/i18n/locale";
import { inviteDocId, inviteEmailHash, newInviteCode, newWaveId } from "./ids";
import { inviteConnections, inviteLock, type InviteLockReason } from "./eligibility";
import { defaultInviteCopy, ensureInviteLink } from "./render";
import { isInviteLinksConfigured } from "./token";
import { forgetNoInvites } from "./attribution";

/**
 * Invite waves (nav v2 phase 4): a draft names the product, how many people (from
 * the top of the ranking) and the email; sending creates one invite per person
 * and queues its email. Drafts can come from a person or from Vizzy; only a
 * person sends.
 */

export interface InviteSetup {
  campaign: Campaign;
  connections: ProductConnection[];
  /** Connections an invite can point at (custom, active, not staging, valid sign-up link). */
  eligible: ProductConnection[];
  lock: InviteLockReason | null;
}

/** Links need both a signing key and a public origin to point at. */
export function inviteLinksReady(): boolean {
  return isInviteLinksConfigured() && !!emailLinkOrigin();
}

export async function loadInviteSetup(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<InviteSetup | null> {
  const repos = forTenant(ctx, db);
  const [campaign, connections] = await Promise.all([
    repos.campaigns.getById(campaignId),
    repos.productConnections.find({ limit: 100 }),
  ]);
  if (!campaign) return null;
  return {
    campaign,
    connections,
    eligible: inviteConnections(connections),
    lock: inviteLock({ archived: !!campaign.archivedAt, keyConfigured: inviteLinksReady(), connections }),
  };
}

export const WaveInputSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    connectionId: z.string().min(1).max(80).optional(),
    size: z.number().int().min(1).max(INVITE_LIMITS.maxWaveSize),
    excludeExistingUsers: z.boolean().optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
    heroImageUrl: z.string().url().max(2000).nullable().optional(),
    expiresInDays: z.number().int().min(INVITE_LIMITS.minExpiryDays).max(INVITE_LIMITS.maxExpiryDays).optional(),
  })
  .strict();
export type WaveInput = z.infer<typeof WaveInputSchema>;

export const WavePatchSchema = WaveInputSchema.partial().strict();

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string; detail?: string };

/** Create a DRAFT wave. Locked launches can't have drafts: there'd be nowhere to invite people to. */
export async function createWaveDraft(
  ctx: TenantContext,
  campaignId: string,
  input: WaveInput,
  actor: { userId?: string | null; authoredBy: "human" | "agent" },
  db?: FirestoreLike,
): Promise<Result<InviteWave>> {
  const setup = await loadInviteSetup(ctx, campaignId, db);
  if (!setup) return { ok: false, status: 404, error: "campaign_not_found" };
  if (setup.lock) return { ok: false, status: 409, error: "invites_locked", detail: setup.lock };
  const connection = input.connectionId
    ? setup.eligible.find((c) => c.id === input.connectionId)
    : setup.eligible[0];
  if (!connection) return { ok: false, status: 400, error: "connection_not_eligible" };

  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const copy = defaultInviteCopy(resolveCampaignLocale(setup.campaign, tenant));
  const now = new Date().toISOString();
  const id = newWaveId();
  const doc: Omit<InviteWave, "id" | "tenantId"> = {
    campaignId,
    connectionId: connection.id,
    name: input.name || `Invite wave · ${now.slice(0, 10)}`,
    status: "draft",
    size: input.size,
    excludeExistingUsers: input.excludeExistingUsers ?? true,
    subject: input.subject ?? copy.subject,
    body: ensureInviteLink(input.body ?? copy.body),
    heroImageUrl: input.heroImageUrl ?? null,
    expiresInDays: input.expiresInDays ?? INVITE_LIMITS.defaultExpiryDays,
    authoredBy: actor.authoredBy,
    counts: { selected: 0, created: 0, skipped: 0 },
    createdBy: actor.userId ?? null,
    sentBy: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const wave = await forTenant(ctx, db).inviteWaves.create(id, doc);
  return { ok: true, value: wave };
}

/** Edit a draft (sent and sending waves are history). */
export async function updateWaveDraft(
  ctx: TenantContext,
  waveId: string,
  patch: z.infer<typeof WavePatchSchema>,
  opts: { authoredBy?: "human" | "agent"; db?: FirestoreLike } = {},
): Promise<Result<InviteWave>> {
  const repos = forTenant(ctx, opts.db);
  if (patch.connectionId) {
    const wave = await repos.inviteWaves.getById(waveId);
    if (!wave) return { ok: false, status: 404, error: "wave_not_found" };
    const setup = await loadInviteSetup(ctx, wave.campaignId, opts.db);
    if (!setup?.eligible.some((c) => c.id === patch.connectionId)) {
      return { ok: false, status: 400, error: "connection_not_eligible" };
    }
  }
  const now = new Date().toISOString();
  const updated = await repos.inviteWaves.claim(waveId, (cur) => {
    if (cur.status !== "draft") return null;
    return {
      ...patch,
      ...(patch.body ? { body: ensureInviteLink(patch.body) } : {}),
      ...(opts.authoredBy ? { authoredBy: opts.authoredBy } : {}),
      updatedAt: now,
    };
  });
  if (!updated) {
    const exists = await repos.inviteWaves.getById(waveId);
    return exists
      ? { ok: false, status: 409, error: "wave_not_draft" }
      : { ok: false, status: 404, error: "wave_not_found" };
  }
  return { ok: true, value: updated };
}

export async function deleteWaveDraft(ctx: TenantContext, waveId: string, db?: FirestoreLike): Promise<Result<null>> {
  const repos = forTenant(ctx, db);
  const wave = await repos.inviteWaves.getById(waveId);
  if (!wave) return { ok: false, status: 404, error: "wave_not_found" };
  if (wave.status !== "draft") return { ok: false, status: 409, error: "wave_not_draft" };
  await repos.inviteWaves.delete(waveId);
  return { ok: true, value: null };
}

export interface Selection {
  selected: Signup[];
  /** Verified people passed over because they were already invited, have no email, or already use the product. */
  alreadyInvited: number;
  noEmail: number;
  existingUsers: number;
}

/**
 * Who a wave would invite: verified people from the top of the ranking, skipping
 * anyone already invited from this launch, anyone without an email and (by
 * default) anyone who already uses the product.
 */
export async function selectInvitees(
  ctx: TenantContext,
  wave: Pick<InviteWave, "campaignId" | "connectionId" | "size" | "excludeExistingUsers">,
  db?: FirestoreLike,
): Promise<Selection> {
  const repos = forTenant(ctx, db);
  const [ranked, invites] = await Promise.all([
    rankedSignups(ctx, wave.campaignId, db),
    repos.invites.find({ where: [["campaignId", "==", wave.campaignId]] }),
  ]);
  const invited = new Set(invites.map((i) => i.signupId));
  const out: Selection = { selected: [], alreadyInvited: 0, noEmail: 0, existingUsers: 0 };
  const candidates: Signup[] = [];
  for (const s of ranked) {
    if (invited.has(s.id)) out.alreadyInvited += 1;
    else if (!s.email) out.noEmail += 1;
    else candidates.push(s);
  }
  // Walk the ranking in chunks of 30 (the `in` limit), keeping order, until the wave is full.
  for (let i = 0; i < candidates.length && out.selected.length < wave.size; i += 30) {
    const chunk = candidates.slice(i, i + 30);
    let users = new Set<string>();
    if (wave.excludeExistingUsers) {
      const found = await repos.productUsers.find({
        where: [
          ["connectionId", "==", wave.connectionId],
          ["emailNormalized", "in", chunk.map((s) => normalizeEmail(s.email!))],
        ],
      });
      users = new Set(found.filter((u) => u.status === "active").map((u) => u.emailNormalized ?? ""));
    }
    for (const s of chunk) {
      if (out.selected.length >= wave.size) break;
      if (users.has(normalizeEmail(s.email!))) out.existingUsers += 1;
      else out.selected.push(s);
    }
  }
  return out;
}

export interface SendWaveDeps {
  db?: FirestoreLike;
  /** Kick one inline drain after queueing (dev has no email cron). Tests pass a stub. */
  kick?: (ctx: TenantContext) => Promise<unknown>;
}

/**
 * Send a draft wave: claim it, re-check the lock, create one invite per selected
 * person (atomic, so nobody is ever invited twice from this launch) and queue
 * their emails. The people come off the waitlist as each email goes out.
 */
export async function sendInviteWave(
  ctx: TenantContext,
  waveId: string,
  actor: { userId?: string | null },
  deps: SendWaveDeps = {},
): Promise<Result<InviteWave>> {
  const repos = forTenant(ctx, deps.db);
  const draft = await repos.inviteWaves.getById(waveId);
  if (!draft) return { ok: false, status: 404, error: "wave_not_found" };
  if (draft.status !== "draft") return { ok: false, status: 409, error: "wave_not_draft" };
  const setup = await loadInviteSetup(ctx, draft.campaignId, deps.db);
  if (!setup) return { ok: false, status: 404, error: "campaign_not_found" };
  if (setup.lock) return { ok: false, status: 409, error: "invites_locked", detail: setup.lock };
  if (!setup.eligible.some((c) => c.id === draft.connectionId)) {
    return { ok: false, status: 409, error: "connection_not_eligible" };
  }

  const now = new Date().toISOString();
  const wave = await repos.inviteWaves.claim(waveId, (cur) =>
    cur.status === "draft" ? { status: "sending" as const, sentBy: actor.userId ?? null, sentAt: now, updatedAt: now } : null,
  );
  if (!wave) return { ok: false, status: 409, error: "wave_not_draft" };

  const selection = await selectInvitees(ctx, wave, deps.db);
  let created = 0;
  let skipped = selection.alreadyInvited + selection.noEmail + selection.existingUsers;
  for (let i = 0; i < selection.selected.length; i += 25) {
    const chunk = selection.selected.slice(i, i + 25);
    const results = await Promise.all(chunk.map((s) => createInvite(ctx, wave, s, now, deps.db)));
    for (const r of results) {
      if (r) created += 1;
      else skipped += 1;
    }
  }
  const counts = { selected: selection.selected.length, created, skipped };
  await repos.inviteWaves.update(waveId, { status: "sent", counts, updatedAt: new Date().toISOString() });
  if (created > 0) {
    if (wave.connectionId) forgetNoInvites(ctx.tenantId, wave.connectionId);
    const kick = deps.kick ?? ((c: TenantContext) => processEmailJobs(c));
    await kick(ctx).catch((e) => console.warn(`[invites] inline drain after wave ${waveId}:`, e));
  }
  return { ok: true, value: { ...wave, status: "sent", counts } };
}

/** One invite + its queued email. False when this person was already invited (the atomic create collided). */
async function createInvite(
  ctx: TenantContext,
  wave: InviteWave,
  signup: Signup,
  now: string,
  db?: FirestoreLike,
): Promise<boolean> {
  const id = inviteDocId(wave.campaignId, signup.id);
  const doc: Omit<Invite, "id" | "tenantId"> = {
    campaignId: wave.campaignId,
    waveId: wave.id,
    signupId: signup.id,
    connectionId: wave.connectionId,
    emailHash: inviteEmailHash(ctx.tenantId, signup.email!),
    code: newInviteCode(),
    status: "queued",
    skipReason: null,
    invited: false,
    invitedAt: null,
    clicked: false,
    clickedAt: null,
    clickCount: 0,
    signedUp: false,
    signedUpAt: null,
    activated: false,
    activatedAt: null,
    productUserId: null,
    matchedBy: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await forTenant(ctx, db).invites.create(id, doc);
  } catch (err) {
    if (err instanceof TenantIsolationError) return false;
    throw err;
  }
  await enqueueEmailJob(
    ctx,
    { type: "invite", campaignId: wave.campaignId, dedupeKey: `invite:${id}`, payload: { inviteId: id } },
    db,
  );
  return true;
}

/** Stop a wave: its not-yet-sent invites are cancelled as their jobs come up. */
export async function cancelInviteWave(ctx: TenantContext, waveId: string, db?: FirestoreLike): Promise<Result<InviteWave>> {
  const now = new Date().toISOString();
  const wave = await forTenant(ctx, db).inviteWaves.claim(waveId, (cur) =>
    cur.status === "cancelled" ? null : { status: "cancelled" as const, updatedAt: now },
  );
  if (!wave) return { ok: false, status: 404, error: "wave_not_found" };
  return { ok: true, value: wave };
}

/** A launch's waves, newest first. */
export async function listWaves(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<InviteWave[]> {
  const waves = await forTenant(ctx, db).inviteWaves.find({ where: [["campaignId", "==", campaignId]], limit: 200 });
  return waves.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
