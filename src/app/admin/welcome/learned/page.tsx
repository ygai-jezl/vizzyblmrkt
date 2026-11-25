import { notFound, redirect } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { TEXT_MODEL } from "@/lib/agents/modelConfig";
import { isOnboardingEnabled } from "@/lib/onboarding/flags";
import { blankLearned } from "@/lib/onboarding/learn";
import { getConversation } from "@/lib/onboarding/store";
import { isConversationId, readLearned } from "@/lib/types/onboarding";
import { LearnedReview } from "@/components/admin/onboarding/LearnedReview";

export const dynamic = "force-dynamic";

/**
 * Here's what I learned, for one ended conversation (`?c=oc_...`). The layout checks the switch
 * and the admin; this page checks them again before it reads, since a page renders beside its
 * layout. A conversation already confirmed goes Home: its review is done, and Settings edits it.
 */
export default async function LearnedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { c } = await searchParams;
  if (!isOnboardingEnabled() || !isConversationId(c)) notFound();
  const ctx = await requireAdminContext();
  if (ctx.role !== "admin") redirect("/admin");
  const conversation = await getConversation(ctx, c);
  if (!conversation || conversation.status !== "ended") notFound();
  if (conversation.confirmedAt) redirect("/admin");
  const learned = readLearned(conversation.learned) ?? blankLearned(TEXT_MODEL, conversation.endedAt ?? conversation.startedAt);
  return (
    <LearnedReview
      conversation={{
        id: conversation.id,
        source: conversation.source,
        startedAt: conversation.startedAt,
        lengthSec: conversation.lengthSec ?? 0,
        turnCount: (conversation.turns ?? []).length,
      }}
      learned={{ answers: learned.answers, facts: learned.facts }}
    />
  );
}
