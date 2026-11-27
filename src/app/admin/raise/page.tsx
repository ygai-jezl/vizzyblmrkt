import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isPlansUiEnabled } from "@/lib/plans/flags";
import { canUseRaiseKit } from "@/lib/raise/docs/adminApi";
import { isRaiseKitEnabled } from "@/lib/raise/docs/flags";
import { listRaiseDocs } from "@/lib/raise/docs/store";
import { RAISE_DOC_LIMITS } from "@/lib/raise/docs/types";
import { RaiseKitList } from "@/components/admin/raise-deck/RaiseKitList";

export const dynamic = "force-dynamic";

/** Content › Raise kit (RAISE_KIT_ENABLED): the brand's decks and New deck. Not found while the switch is off. */
export default async function RaiseKitPage() {
  if (!isRaiseKitEnabled()) notFound();
  const ctx = await requireAdminContext();
  const [docs, granted] = await Promise.all([listRaiseDocs(ctx).catch(() => []), canUseRaiseKit(ctx).catch(() => false)]);
  return <RaiseKitList docs={docs} granted={granted} isAdmin={ctx.role === "admin"} limit={RAISE_DOC_LIMITS.decks} plansUi={isPlansUiEnabled()} />;
}
