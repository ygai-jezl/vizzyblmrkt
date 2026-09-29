/**
 * The chat's canvas card, read from an agent tool result. Pure + client-safe: the
 * result comes off the agent stream, so every field is checked before it's shown.
 */

/** A draft an agent saved on a canvas during this turn (shown as a card). */
export interface CanvasCardData {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  url: string;
  stats: Array<{ label: string; value: string | number }>;
  warnings: number;
  /** The line under the stats; the card says "Draft — nothing sends until you publish." without it. */
  note?: string;
  /** The link's label; "Open canvas" without it. */
  cta?: string;
}

const NOTE_MAX = 160;
const CTA_MAX = 40;

/** A trimmed, clipped string, or undefined for anything else (or a blank one). */
function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().slice(0, max).trim() || undefined;
}

export function asCard(result: Record<string, unknown> | undefined): CanvasCardData | null {
  const card = result?.card as Partial<CanvasCardData> | undefined;
  if (!card || typeof card !== "object" || typeof card.url !== "string" || typeof card.id !== "string") return null;
  // Only same-app links: a card can never point the operator off-site.
  if (!card.url.startsWith("/admin/")) return null;
  const note = clip(card.note, NOTE_MAX);
  const cta = clip(card.cta, CTA_MAX);
  return {
    kind: String(card.kind ?? "canvas"),
    id: card.id,
    title: String(card.title ?? "Draft"),
    subtitle: typeof card.subtitle === "string" ? card.subtitle : undefined,
    url: card.url,
    stats: Array.isArray(card.stats) ? card.stats.slice(0, 6) : [],
    warnings: typeof card.warnings === "number" ? card.warnings : 0,
    ...(note ? { note } : {}),
    ...(cta ? { cta } : {}),
  };
}

/** Who hears about the cards one chat saves; `add` returns the unsubscribe. */
export interface CardListeners {
  add: (listener: (card: CanvasCardData) => void) => () => void;
  emit: (card: CanvasCardData) => void;
}

/**
 * Listeners for the cards Vizzy saves in one chat (the Ask Vizzy panel's), so a page in view can
 * reload its own draft. A listener that throws doesn't stop the others, or the chat's stream.
 */
export function cardListeners(): CardListeners {
  const listeners = new Set<(card: CanvasCardData) => void>();
  return {
    add: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (card) => {
      for (const listener of [...listeners]) {
        try {
          listener(card);
        } catch (err) {
          console.error("[dashboard-chat] a saved-card listener failed:", err);
        }
      }
    },
  };
}
