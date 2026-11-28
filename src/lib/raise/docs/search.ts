import { isSearchIndexEnabled } from "@/lib/search/flags";
import { indexInBackground, removeInBackground } from "@/lib/search/indexer";
import { contentHash } from "@/lib/search/text";
import type { SearchSource, SearchStub } from "@/lib/search/types";
import type { TenantContext } from "@/lib/tenant/types";
import { isRaiseKitEnabled } from "./flags";
import { labelWords, renderText } from "./text";
import type { RaiseDoc, Slide } from "./types";

/**
 * Decks in brand search (kind raise_doc, "Deck"): one part per slide, titled "Slide 4: {headline}",
 * rendered with the numbers each version froze, so "4,310 joined the waitlist" is findable. A save
 * writes through straight away; a delete takes the deck out. Off (RAISE_KIT_ENABLED or the index),
 * nothing is written, and the sweep lists no decks, so it removes any that were indexed.
 */

type Ctx = Pick<TenantContext, "tenantId" | "region">;
/** What the source needs of a deck: a list projection gives exactly this (never `versions`). */
export type SearchableDeck = Pick<RaiseDoc, "id" | "version"> & { current: { title: string; slides: Slide[] } };

export const deckUrl = (id: string) => `/admin/raise/${id}`;

function slideText(s: Slide, now: Date): string {
  const r = (t: string) => renderText(t, s.blocks).trim();
  const parts = [
    r(s.headline),
    ...s.points.map(r),
    ...(s.compare ? [`${s.compare.leftTitle}: ${s.compare.rows.map((x) => r(x.left)).join("; ")}`, `${s.compare.rightTitle}: ${s.compare.rows.map((x) => r(x.right)).join("; ")}`] : []),
    ...(s.people ?? []).map((p) => [p.name, p.role, p.line].filter(Boolean).join(", ")),
    ...s.blocks.filter((b) => b.display).map((b) => `${b.name}: ${b.display}${b.periodWords ? `, ${b.periodWords}` : ""} (${labelWords(b, now)})`),
    r(s.notes),
  ];
  return parts.filter(Boolean).join("\n");
}

/** The deck as a search source: one part per slide. Pure. */
export function raiseDocSource(doc: SearchableDeck, now: Date = new Date()): SearchSource {
  const url = deckUrl(doc.id);
  return {
    kind: "raise_doc",
    ref: doc.id,
    title: doc.current.title,
    body: "",
    url,
    parts: doc.current.slides.map((s, i) => ({ title: `Slide ${i + 1}: ${renderText(s.headline, s.blocks).trim()}`.slice(0, 200), text: slideText(s, now), url: `${url}?slide=${i + 1}` })),
  };
}

/** The sweep's view of a deck: its version changes on every save, so an unchanged deck is never read again. */
export function raiseDocStub(doc: SearchableDeck): SearchStub {
  return { kind: "raise_doc", ref: doc.id, version: contentHash("raise_doc", doc.id, String(doc.version), doc.current.title), load: async () => raiseDocSource(doc) };
}

/** A deck was saved: index it after the response. Never slows or breaks the save. */
export function indexDeckAfterSave(ctx: Ctx, doc: SearchableDeck): void {
  if (!isRaiseKitEnabled() || !isSearchIndexEnabled()) return;
  indexInBackground(ctx, raiseDocSource(doc));
}

/** A deck was deleted: take it out of the index. */
export function removeDeckAfterDelete(ctx: Ctx, id: string): void {
  if (!isSearchIndexEnabled()) return;
  removeInBackground(ctx, "raise_doc", id);
}
