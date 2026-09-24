import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { InviteWave } from "@/lib/types/invite";
import { INVITE_LIMITS } from "@/lib/types/invite";
import { sendEmail } from "@/lib/email";
import { resolveSender } from "@/lib/email/sender";
import { journeyFooterValues } from "@/lib/email/footer";
import { resolveCampaignLocale } from "@/lib/i18n/locale";
import { zodReason } from "@/lib/connect/protocol";
import { INVITE_LOCK_TEXT, inviteProductName } from "./eligibility";
import { loadFunnel } from "./funnel";
import { INVITE_TAGS, defaultInviteCopy, renderInviteEmail } from "./render";
import {
  WaveInputSchema,
  WavePatchSchema,
  cancelInviteWave,
  createWaveDraft,
  deleteWaveDraft,
  listWaves,
  loadInviteSetup,
  selectInvitees,
  sendInviteWave,
  updateWaveDraft,
  type SendWaveDeps,
} from "./waves";

/**
 * The admin API behind a launch's Invites page (nav v2 phase 4). Plain functions
 * returning { status, body } so they're tested without HTTP; the routes under
 * /api/admin/campaigns/[campaignId]/invites/* are thin wrappers.
 */

export type ApiResult = { status: number; body: unknown };
const ok = (body: unknown, status = 200): ApiResult => ({ status, body });
const fail = (status: number, error: string, detail?: string): ApiResult => ({
  status,
  body: detail ? { error, detail } : { error },
});

type WaveResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; detail?: string };
const fromResult = <T>(r: WaveResult<T>, key: string, status = 200): ApiResult =>
  r.ok ? ok({ [key]: r.value }, status) : fail(r.status, r.error, r.detail);

export interface WaveProgress {
  queued: number;
  invited: number;
  signedUp: number;
  activated: number;
  skipped: number;
  failed: number;
}

async function waveProgress(ctx: TenantContext, waveId: string, db?: FirestoreLike): Promise<WaveProgress> {
  const inv = forTenant(ctx, db).invites;
  const w = ["waveId", "==", waveId] as const;
  const [queued, invited, signedUp, activated, skipped, failed] = await Promise.all([
    inv.count([[...w], ["status", "==", "queued"]]),
    inv.count([[...w], ["invited", "==", true]]),
    inv.count([[...w], ["signedUp", "==", true]]),
    inv.count([[...w], ["activated", "==", true]]),
    inv.count([[...w], ["status", "==", "skipped"]]),
    inv.count([[...w], ["status", "==", "failed"]]),
  ]);
  return { queued, invited, signedUp, activated, skipped, failed };
}

/** Everything the Invites page needs: the lock, eligible products, the funnel, and recent waves with progress. */
export async function getLaunchInvites(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<ApiResult> {
  const setup = await loadInviteSetup(ctx, campaignId, db);
  if (!setup) return fail(404, "campaign_not_found");
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const [funnel, waves, waiting] = await Promise.all([
    loadFunnel(ctx, { campaignId }, db),
    listWaves(ctx, campaignId, db),
    forTenant(ctx, db).signups.count([
      ["campaignId", "==", campaignId],
      ["status", "==", "verified_active"],
    ]),
  ]);
  const recent = waves.slice(0, 10);
  const progress = await Promise.all(recent.map((w) => (w.status === "draft" ? null : waveProgress(ctx, w.id, db))));
  return ok({
    lock: setup.lock,
    lockText: setup.lock ? INVITE_LOCK_TEXT[setup.lock] : null,
    connections: setup.eligible.map((c) => ({
      id: c.id,
      name: c.name,
      productName: inviteProductName(c),
      signupUrl: c.signupUrl ?? null,
    })),
    funnel,
    waiting,
    waves: recent.map((w, i) => ({ ...w, progress: progress[i] })),
    defaults: {
      ...defaultInviteCopy(resolveCampaignLocale(setup.campaign, tenant)),
      expiresInDays: INVITE_LIMITS.defaultExpiryDays,
      maxSize: INVITE_LIMITS.maxWaveSize,
      minExpiryDays: INVITE_LIMITS.minExpiryDays,
      maxExpiryDays: INVITE_LIMITS.maxExpiryDays,
    },
    tags: INVITE_TAGS,
  });
}

async function waveInLaunch(ctx: TenantContext, campaignId: string, waveId: string, db?: FirestoreLike) {
  const wave = await forTenant(ctx, db).inviteWaves.getById(waveId);
  return wave && wave.campaignId === campaignId ? wave : null;
}

export async function createWave(ctx: TenantContext, campaignId: string, input: unknown, db?: FirestoreLike): Promise<ApiResult> {
  const parsed = WaveInputSchema.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  return fromResult(
    await createWaveDraft(ctx, campaignId, parsed.data, { userId: ctx.userId ?? null, authoredBy: "human" }, db),
    "wave",
    201,
  );
}

export async function getWave(ctx: TenantContext, campaignId: string, waveId: string, db?: FirestoreLike): Promise<ApiResult> {
  const wave = await waveInLaunch(ctx, campaignId, waveId, db);
  if (!wave) return fail(404, "wave_not_found");
  return ok({ wave, progress: wave.status === "draft" ? null : await waveProgress(ctx, waveId, db) });
}

export async function patchWave(
  ctx: TenantContext,
  campaignId: string,
  waveId: string,
  input: unknown,
  db?: FirestoreLike,
): Promise<ApiResult> {
  if (!(await waveInLaunch(ctx, campaignId, waveId, db))) return fail(404, "wave_not_found");
  const parsed = WavePatchSchema.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  return fromResult(await updateWaveDraft(ctx, waveId, parsed.data, { db }), "wave");
}

export async function removeWave(ctx: TenantContext, campaignId: string, waveId: string, db?: FirestoreLike): Promise<ApiResult> {
  if (!(await waveInLaunch(ctx, campaignId, waveId, db))) return fail(404, "wave_not_found");
  const r = await deleteWaveDraft(ctx, waveId, db);
  return r.ok ? ok({ ok: true }) : fail(r.status, r.error);
}

/** Who a draft would reach (counts only) and a rendered sample, before anything is sent. */
export async function previewWave(ctx: TenantContext, campaignId: string, waveId: string, db?: FirestoreLike): Promise<ApiResult> {
  const wave = await waveInLaunch(ctx, campaignId, waveId, db);
  if (!wave) return fail(404, "wave_not_found");
  const setup = await loadInviteSetup(ctx, campaignId, db);
  const connection = setup?.eligible.find((c) => c.id === wave.connectionId);
  if (!setup || !connection) return fail(409, "connection_not_eligible");
  const selection = await selectInvitees(ctx, wave, db);
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const first = selection.selected[0];
  const sample = first
    ? renderInviteEmail({
        subject: wave.subject,
        body: wave.body,
        heroImageUrl: wave.heroImageUrl ?? null,
        merge: {
          signup: first,
          campaign: setup.campaign,
          footer: journeyFooterValues({ tenant, campaign: setup.campaign, unsubscribeUrl: "#" }),
        },
        inviteUrl: connection.signupUrl ?? "#",
        productName: inviteProductName(connection),
        expiresInDays: wave.expiresInDays,
        locale: first.locale ?? resolveCampaignLocale(setup.campaign, tenant),
      })
    : null;
  return ok({
    selected: selection.selected.length,
    alreadyInvited: selection.alreadyInvited,
    noEmail: selection.noEmail,
    existingUsers: selection.existingUsers,
    sample: sample ? { subject: sample.subject, html: sample.html } : null,
  });
}

export async function sendWave(
  ctx: TenantContext,
  campaignId: string,
  waveId: string,
  deps: SendWaveDeps = {},
): Promise<ApiResult> {
  if (!(await waveInLaunch(ctx, campaignId, waveId, deps.db))) return fail(404, "wave_not_found");
  return fromResult(await sendInviteWave(ctx, waveId, { userId: ctx.userId ?? null }, deps), "wave");
}

export async function cancelWave(ctx: TenantContext, campaignId: string, waveId: string, db?: FirestoreLike): Promise<ApiResult> {
  if (!(await waveInLaunch(ctx, campaignId, waveId, db))) return fail(404, "wave_not_found");
  return fromResult(await cancelInviteWave(ctx, waveId, db), "wave");
}

/**
 * Send the draft to the signed-in admin as a test. The button in a test goes
 * straight to the product's sign-up page (no invite code), and nobody is invited.
 */
export async function sendTestInvite(ctx: TenantContext, campaignId: string, waveId: string, db?: FirestoreLike): Promise<ApiResult> {
  if (!ctx.email) return fail(400, "no_email_on_account");
  const wave = await waveInLaunch(ctx, campaignId, waveId, db);
  if (!wave) return fail(404, "wave_not_found");
  const setup = await loadInviteSetup(ctx, campaignId, db);
  const connection = setup?.eligible.find((c) => c.id === wave.connectionId);
  if (!setup || !connection) return fail(409, "connection_not_eligible");
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const sample = {
    id: "test",
    tenantId: ctx.tenantId,
    campaignId,
    firstName: "there",
    email: ctx.email,
  } as unknown as Parameters<typeof renderInviteEmail>[0]["merge"]["signup"];
  const rendered = renderInviteEmail({
    subject: wave.subject,
    body: wave.body,
    heroImageUrl: wave.heroImageUrl ?? null,
    merge: { signup: sample, campaign: setup.campaign, footer: journeyFooterValues({ tenant, campaign: setup.campaign, unsubscribeUrl: "#" }) },
    inviteUrl: connection.signupUrl!,
    productName: inviteProductName(connection),
    expiresInDays: wave.expiresInDays,
    locale: resolveCampaignLocale(setup.campaign, tenant),
  });
  const sender = resolveSender(tenant, setup.campaign);
  const res = await sendEmail({
    to: ctx.email,
    subject: `[Test] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
    fromEmail: sender.fromEmail,
    fromName: sender.fromName,
    replyTo: sender.replyTo,
    track: { opens: false, clicks: false },
    tags: ["invite-test"],
  });
  if (!res.sent && res.provider !== "log") return fail(502, "send_failed", res.reason ?? undefined);
  return ok({ ok: true, to: ctx.email });
}

/** For Products › Setup: whether this product has a sign-up link, and its invite numbers. */
export async function connectionInvites(ctx: TenantContext, connectionId: string, db?: FirestoreLike): Promise<ApiResult> {
  const repos = forTenant(ctx, db);
  const conn = await repos.productConnections.getById(connectionId);
  if (!conn) return fail(404, "not_found");
  const c = ["connectionId", "==", connectionId] as const;
  const [invited, signedUp] = await Promise.all([
    repos.invites.count([[...c], ["invited", "==", true]]),
    repos.invites.count([[...c], ["signedUp", "==", true]]),
  ]);
  return ok({ hasSignupUrl: !!conn.signupUrl, invited, signedUp });
}

export type { InviteWave };
