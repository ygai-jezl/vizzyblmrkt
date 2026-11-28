import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isBrandKitUiEnabled } from "@/lib/content/brandKit";
import { deckView } from "@/lib/raise/docs/adminApi";
import { isRaiseKitEnabled, isVizzyRaiseEnabled } from "@/lib/raise/docs/flags";
import { readRaiseDoc } from "@/lib/raise/docs/store";
import { DeckStudio } from "@/components/admin/raise-deck/DeckStudio";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ docId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The deck studio (Content › Raise kit › Deck): the deck, its checks, talk time, versions and look,
 * worked out on the server. Not found while RAISE_KIT_ENABLED is off or the deck isn't this brand's.
 * `?slide=n` opens slide n, as brand search links one.
 */
export default async function RaiseDeckPage({ params, searchParams }: Props) {
  if (!isRaiseKitEnabled()) notFound();
  const ctx = await requireAdminContext();
  const [{ docId }, query] = await Promise.all([params, searchParams]);
  const doc = await readRaiseDoc(ctx, docId);
  if (!doc) notFound();
  const view = await deckView(ctx, doc);
  const slide = Number(one(query.slide));
  return (
    <DeckStudio
      initial={view}
      initialSlide={Number.isInteger(slide) && slide >= 1 ? slide - 1 : 0}
      vizzy={isVizzyRaiseEnabled()}
      brandHref={isBrandKitUiEnabled() ? "/admin/brand-kit" : "/admin/account/brand"}
      outlineNotice={one(query.outline) === "1"}
    />
  );
}
