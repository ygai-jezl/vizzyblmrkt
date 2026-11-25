import { forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ConversationTurn } from "@/lib/types/signup";
import { isPersonId } from "./paths";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { ideaWord } from "@/lib/nav/terms";

/**
 * A voice chat on a sign-up page, in full (piece B): what the person and the brand's voice agent
 * said, for "Read the conversation". Admins only (its route uses oneViewAdmin with mutate, as
 * export does). It is exported and erased with the person, as their sign-up is. The summary is
 * what the person's browser sent when the chat ended: nobody has checked it.
 */

export interface VoiceChat {
  signupId: string;
  launchName: string;
  brandName: string;
  personName: string | null;
  at: string;
  summary: string | null;
  turns: ConversationTurn[];
}

/**
 * One of this person's voice chats, or null when the sign-up isn't theirs, isn't this brand's,
 * or has no finished chat. A sign-up is theirs when their record links it, or it was made with
 * their address (or, for someone with no address, their phone).
 */
export async function loadVoiceChat(ctx: TenantContext, personId: string, signupId: string, db?: FirestoreLike): Promise<VoiceChat | null> {
  if (!isPersonId(personId) || !isPersonId(signupId)) return null;
  const repo = forTenant(ctx, db);
  const [contact, signup] = await Promise.all([repo.contacts.getById(personId), repo.signups.getById(signupId)]);
  if (!contact || !signup) return null;
  const email = contact.email?.trim().toLowerCase() || null;
  const theirs =
    (contact.campaigns ?? []).some((c) => c.signupId === signup.id) ||
    (email ? signup.email?.trim().toLowerCase() === email : !!contact.phone && !signup.email && signup.phone?.trim() === contact.phone.trim());
  const chat = signup.aiConversation;
  if (!theirs || !chat?.completed) return null;
  const [campaign, tenant] = await Promise.all([
    repo.campaigns.getById(signup.campaignId).catch(() => null),
    (db ? getTenantById(ctx.tenantId, db) : getTenantById(ctx.tenantId)).catch(() => null),
  ]);
  return {
    signupId: signup.id,
    // An unnamed launch, in the words in use.
    launchName: campaign?.waitlistName || ideaWord(isIdeaWordsEnabled()).A,
    brandName: tenant?.tenantName || "your brand",
    personName: [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || null,
    at: chat.capturedAt,
    summary: chat.summary?.trim() || null,
    turns: (chat.transcript ?? []).map((t) => ({ role: t.role, text: t.text })),
  };
}
