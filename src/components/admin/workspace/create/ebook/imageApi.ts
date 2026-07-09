import type { EbookImageSlot } from "@/lib/types/contentPlan";

/**
 * The image actions the reading pane's slot cards call. Owned + wired by EbookStudio (which
 * opens the composer / persists), threaded down through EbookReadingPane → ChapterCard. All
 * no-ops until Slice 2b; passed as `undefined` renders inert placeholders.
 */
export interface EbookImageApi {
  /** Authenticated /asset proxy URL for a stored image filename. */
  assetUrl: (ref: string) => string;
  /** Open the composer to generate into this slot (seeded from its context brief). */
  onGenerate: (chapterId: string, slot: EbookImageSlot) => void;
  /** Open the composer in edit/refine mode for this (already-generated) slot. */
  onEdit: (chapterId: string, slot: EbookImageSlot) => void;
  /** Upload an operator image onto this slot. */
  onUpload: (chapterId: string, slot: EbookImageSlot, file: File) => void;
  /** Remove the slot (drops its anchor). */
  onRemove: (chapterId: string, slotId: string) => void;
  /** Persist a new rendered width (% of column). */
  onResize: (chapterId: string, slotId: string, width: number) => void;
}
