import { z } from "zod";
import { forTenant, getTenantById, isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import { INVITE_LIMITS, type InviteWave } from "@/lib/types/invite";
import { draftCopy } from "@/lib/agents/creative";
import { resolveBrandVoiceText } from "@/lib/content/create/brandContext";
import { resolveCampaignLocale } from "@/lib/i18n/locale";
import { isInvitesEnabled } from "@/lib/invites/flags";
import { INVITE_LOCK_TEXT } from "@/lib/invites/lockText";
import { inviteProductName } from "@/lib/invites/eligibility";
import { defaultInviteCopy, ensureInviteLink } from "@/lib/invites/render";
import { createWaveDraft, loadInviteSetup, updateWaveDraft } from "@/lib/invites/waves";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `invite_wave` canvas kind (nav v2 phase 4) — Vizzy drafts an invite of a
 * launch's waitlist into the connected product: how many people (from the top
 * of the ranking) and the email. Always a DRAFT: only a person presses Send on
 * the launch's Invites page. Locked launches (no live production product with a
 * sign-up link) are refused with the reason, so Vizzy can say what to do first.
 */

const InviteWaveInput = z.object({
  scope: z
    .object({
      campaignId: z.string().min(1).max(200),
      waveId: z.string().min(1).max(80).nullish(),
    })
    .optional(),
  campaignId: z.string().min(1).max(200).optional(),
  size: z.number().int().min(1).max(INVITE_LIMITS.maxWaveSize).optional(),
  expiresInDays: z.number().int().min(INVITE_LIMITS.minExpiryDays).max(INVITE_LIMITS.maxExpiryDays).optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(20_000).optional(),
});

const AUTHOR_LIMIT = { prefix: "invite_author", burstLimit: 5, hourlyLimit: 20 };

export interface InviteCopyWriter {
  (args: { campaign: Campaign; brief: string; productName: string; brandVoice: string | null; locale: string }): Promise<
    { subject: string; body: string } | null
  >;
}

/** On-brand invite copy from the copywriter; null when it falls back (the default invite copy is used then). */
const writeWithAgent: InviteCopyWriter = async ({ campaign, brief, productName, brandVoice, locale }) => {
  const r = await draftCopy({
    campaign,
    brief:
      `An invite email: ${productName} is ready, and this person on the ${campaign.waitlistName} waitlist is invited in. ` +
      `Put {{invite_link}} on its own line where the button should go, and mention that the link works for ` +
      `{{invite_expires_days}} days. ${brief}`.trim(),
    variantCount: 1,
    brandVoice,
    locale,
  });
  const v = r.source === "agent3" ? r.variants[0] : null;
  return v?.subject && v?.body ? { subject: v.subject, body: v.body } : null;
};

function outcome(wave: InviteWave, campaign: Campaign, edited: boolean): CanvasAuthorOutcome {
  const url = `/admin/launches/${campaign.id}/invites?wave=${wave.id}`;
  return {
    ok: true,
    id: wave.id,
    status: wave.status,
    url,
    summary:
      `${edited ? "Updated the" : "Drafted an"} invite wave for up to ${wave.size.toLocaleString("en-GB")} ` +
      `${wave.size === 1 ? "person" : "people"} from the top of the ${campaign.waitlistName} waitlist. ` +
      `Nothing is sent until you press Send invites on the launch's Invites page.`,
    warnings: [],
    card: {
      kind: "invite_wave",
      id: wave.id,
      title: wave.name,
      subtitle: campaign.waitlistName,
      url,
      stats: [
        { label: "people", value: wave.size },
        { label: "link days", value: wave.expiresInDays },
      ],
      warnings: 0,
    },
  };
}

export async function authorInviteWaveDraft(
  { ctx, input, brief }: CanvasAuthorArgs,
  deps: { db?: FirestoreLike; write?: InviteCopyWriter } = {},
): Promise<CanvasAuthorOutcome> {
  if (!isInvitesEnabled()) return { ok: false, status: 503, error: "unavailable" };
  const req = InviteWaveInput.safeParse(input);
  if (!req.success) {
    return { ok: false, status: 400, error: "invalid_input", issues: req.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const campaignId = req.data.scope?.campaignId ?? req.data.campaignId;
  if (!campaignId) return { ok: false, status: 400, error: "invalid_input", issues: ["scope.campaignId: required"] };
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) {
    return { ok: false, status: 429, error: "rate_limited" };
  }

  const setup = await loadInviteSetup(ctx, campaignId, deps.db);
  if (!setup) return { ok: false, status: 404, error: "campaign_not_found" };
  if (setup.lock) return { ok: false, status: 409, error: "invites_locked", issues: [INVITE_LOCK_TEXT[setup.lock]] };
  const connection = setup.eligible[0]!;

  // The copy: the agent's own words if it sent them, else written on-brand, else the default.
  let copy = req.data.subject && req.data.body ? { subject: req.data.subject, body: req.data.body } : null;
  const tenant = await getTenantById(ctx.tenantId, deps.db).catch(() => null);
  const locale = resolveCampaignLocale(setup.campaign, tenant);
  if (!copy) {
    copy = await (deps.write ?? writeWithAgent)({
      campaign: setup.campaign,
      brief,
      productName: inviteProductName(connection),
      brandVoice: resolveBrandVoiceText({ tenantBrandVoice: tenant?.brandVoice }) || null,
      locale,
    }).catch(() => null);
  }
  copy ??= defaultInviteCopy(locale);
  const body = ensureInviteLink(copy.body);

  const waveId = req.data.scope?.waveId;
  if (waveId) {
    const current = await forTenant(ctx, deps.db).inviteWaves.getById(waveId);
    if (!current || current.campaignId !== campaignId) return { ok: false, status: 404, error: "wave_not_found" };
    const r = await updateWaveDraft(
      ctx,
      waveId,
      {
        subject: copy.subject,
        body,
        ...(req.data.size ? { size: req.data.size } : {}),
        ...(req.data.expiresInDays ? { expiresInDays: req.data.expiresInDays } : {}),
      },
      { authoredBy: "agent", db: deps.db },
    );
    if (!r.ok) return { ok: false, status: r.status, error: r.error };
    return outcome(r.value, setup.campaign, true);
  }

  const waiting = await forTenant(ctx, deps.db)
    .signups.count([
      ["campaignId", "==", campaignId],
      ["status", "==", "verified_active"],
    ])
    .catch(() => 100);
  const r = await createWaveDraft(
    ctx,
    campaignId,
    {
      connectionId: connection.id,
      size: req.data.size ?? Math.min(Math.max(waiting, 1), 100),
      subject: copy.subject,
      body,
      ...(req.data.expiresInDays ? { expiresInDays: req.data.expiresInDays } : {}),
    },
    { userId: ctx.userId ?? null, authoredBy: "agent" },
    deps.db,
  );
  if (!r.ok) return { ok: false, status: r.status, error: r.error, issues: r.detail ? [r.detail] : undefined };
  return outcome(r.value, setup.campaign, false);
}

export const inviteWaveCanvasKind: CanvasKind = {
  kind: "invite_wave",
  label: "waitlist invite",
  authorDraft: (args) => authorInviteWaveDraft(args),
};
