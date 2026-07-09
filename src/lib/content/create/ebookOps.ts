import { z } from "zod";
import {
  EbookAspect,
  CONTENT_PLAN_LIMITS,
  type EbookDoc,
  type EbookChapter,
  type EbookImageSlot,
} from "@/lib/types/contentPlan";
import { buildImageAnchor, stripImageAnchor, reconcileChapterImages } from "./ebookHtml";

/**
 * The structured edit operations the eBook chat can apply to the draft. The chat route
 * validates every op with `EbookOpSchema` and applies them with the PURE `applyEbookOps`
 * reducer against the freshly-read persisted draft (server-authoritative) — the model's
 * conversational reply carries these in a fenced JSON block. Ops that reference ids not in
 * the doc, or that would breach a cap, are silently ignored (never trust model ids).
 */
const CHAPTER_ID = z.string().min(1).max(64);
const SLOT_ID = z.string().min(1).max(64);

export const EbookOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_title"), value: z.string().max(200) }),
  z.object({ op: z.literal("set_subtitle"), value: z.string().max(300) }),
  z.object({ op: z.literal("set_chapter_title"), chapterId: CHAPTER_ID, value: z.string().max(200) }),
  z.object({ op: z.literal("set_chapter_summary"), chapterId: CHAPTER_ID, value: z.string().max(1000) }),
  z.object({
    op: z.literal("add_chapter"),
    afterChapterId: CHAPTER_ID.nullable().optional(),
    title: z.string().min(1).max(200),
    summary: z.string().max(1000).default(""),
  }),
  z.object({ op: z.literal("remove_chapter"), chapterId: CHAPTER_ID }),
  z.object({ op: z.literal("reorder_chapters"), order: z.array(CHAPTER_ID).max(CONTENT_PLAN_LIMITS.MAX_CHAPTERS) }),
  z.object({
    op: z.literal("replace_chapter_body"),
    chapterId: CHAPTER_ID,
    bodyHtml: z.string().max(CONTENT_PLAN_LIMITS.MAX_CHAPTER_CHARS),
  }),
  z.object({
    op: z.literal("insert_image_slot"),
    chapterId: CHAPTER_ID,
    contextPrompt: z.string().max(1000).default(""),
    aspect: EbookAspect.optional(),
  }),
  z.object({ op: z.literal("remove_image_slot"), chapterId: CHAPTER_ID, slotId: SLOT_ID }),
]);
export type EbookOp = z.infer<typeof EbookOpSchema>;

/** Injectable id generators (tests pass deterministic ones). */
export interface EbookOpIds {
  chapter?: () => string;
  slot?: () => string;
}

/** Fold a validated op list onto the draft. Pure; returns a new doc. */
export function applyEbookOps(draft: EbookDoc, ops: EbookOp[], ids: EbookOpIds = {}): EbookDoc {
  const makeChapterId = ids.chapter ?? (() => `ch_${crypto.randomUUID()}`);
  const makeSlotId = ids.slot ?? (() => `img_${crypto.randomUUID()}`);
  return ops.reduce((doc, op) => applyOne(doc, op, makeChapterId, makeSlotId), draft);
}

function mapChapter(doc: EbookDoc, chapterId: string, fn: (c: EbookChapter) => EbookChapter): EbookDoc {
  let found = false;
  const chapters = doc.chapters.map((c) => {
    if (c.id !== chapterId) return c;
    found = true;
    return fn(c);
  });
  return found ? { ...doc, chapters } : doc; // unknown id → no-op
}

function applyOne(
  doc: EbookDoc,
  op: EbookOp,
  makeChapterId: () => string,
  makeSlotId: () => string,
): EbookDoc {
  const { MAX_CHAPTERS, MAX_IMAGES_PER_CHAPTER, MAX_CHAPTER_CHARS } = CONTENT_PLAN_LIMITS;
  switch (op.op) {
    case "set_title":
      // Title is required (min 1) on the schema — ignore a blank set rather than corrupt the doc.
      return op.value.trim() ? { ...doc, title: op.value } : doc;
    case "set_subtitle":
      return { ...doc, subtitle: op.value };
    case "set_chapter_title":
      return op.value.trim() ? mapChapter(doc, op.chapterId, (c) => ({ ...c, title: op.value })) : doc;
    case "set_chapter_summary":
      return mapChapter(doc, op.chapterId, (c) => ({ ...c, summary: op.value }));
    case "add_chapter": {
      if (doc.chapters.length >= MAX_CHAPTERS) return doc;
      const chapter: EbookChapter = {
        id: makeChapterId(),
        title: op.title,
        summary: op.summary ?? "",
        bodyHtml: "",
        status: "planned",
        images: [],
      };
      const chapters = [...doc.chapters];
      const at = op.afterChapterId ? chapters.findIndex((c) => c.id === op.afterChapterId) : -1;
      if (at >= 0) chapters.splice(at + 1, 0, chapter);
      else chapters.push(chapter); // null / unknown afterChapterId → append
      return { ...doc, chapters };
    }
    case "remove_chapter":
      return doc.chapters.some((c) => c.id === op.chapterId)
        ? { ...doc, chapters: doc.chapters.filter((c) => c.id !== op.chapterId) }
        : doc;
    case "reorder_chapters": {
      // Honour the given order for ids that exist; ids not present are dropped; any chapters
      // omitted from `order` keep their relative order at the end (never lost).
      const byId = new Map(doc.chapters.map((c) => [c.id, c]));
      const seen = new Set<string>();
      const reordered: EbookChapter[] = [];
      for (const id of op.order) {
        const c = byId.get(id);
        if (c && !seen.has(id)) {
          reordered.push(c);
          seen.add(id);
        }
      }
      for (const c of doc.chapters) if (!seen.has(c.id)) reordered.push(c);
      return { ...doc, chapters: reordered };
    }
    case "replace_chapter_body":
      return mapChapter(doc, op.chapterId, (c) => ({
        ...c,
        bodyHtml: op.bodyHtml,
        images: reconcileChapterImages(op.bodyHtml, c.images), // drop slots whose anchor is gone
      }));
    case "insert_image_slot":
      return mapChapter(doc, op.chapterId, (c) => {
        if (c.images.length >= MAX_IMAGES_PER_CHAPTER) return c;
        const slot: EbookImageSlot = {
          id: makeSlotId(),
          status: "placeholder",
          imageAssetRef: null,
          aspect: op.aspect ?? "1:1",
          width: 100,
          align: "center",
          wrap: false,
          contextPrompt: op.contextPrompt ?? "",
          imagePrompt: null,
        };
        const anchor = buildImageAnchor(slot.id);
        // No room for the anchor under the body cap → skip (else the sanitize-cap would
        // truncate the just-added anchor and orphan the slot).
        if (c.bodyHtml.length + anchor.length > MAX_CHAPTER_CHARS) return c;
        return { ...c, bodyHtml: `${c.bodyHtml}${anchor}`, images: [...c.images, slot] };
      });
    case "remove_image_slot":
      return mapChapter(doc, op.chapterId, (c) =>
        c.images.some((s) => s.id === op.slotId)
          ? { ...c, bodyHtml: stripImageAnchor(c.bodyHtml, op.slotId), images: c.images.filter((s) => s.id !== op.slotId) }
          : c,
      );
    default:
      return doc;
  }
}

/** Where a generated/uploaded image lands: an existing slot, a new slot in a chapter, or the cover. */
export type EbookImageTarget =
  | { kind: "slot"; chapterId: string; slotId: string }
  | { kind: "new"; chapterId: string }
  | { kind: "cover" };

/**
 * Write a generated/uploaded image result onto the draft — PURE. `slot` updates an existing
 * slot in place; `new` appends a generated slot + anchor to the chapter (cap-guarded, so a
 * near-max body can't orphan it); `cover` sets EbookDoc.coverImage. Unknown chapter/slot ids
 * are a no-op. The transactional mutator re-sanitizes/reconciles after this runs.
 */
export function applyGeneratedImage(
  draft: EbookDoc,
  target: EbookImageTarget,
  image: { imageAssetRef: string; imagePrompt: string | null; aspect: EbookImageSlot["aspect"]; contextPrompt?: string },
  makeSlotId: () => string = () => `img_${crypto.randomUUID()}`,
): EbookDoc {
  const { MAX_IMAGES_PER_CHAPTER, MAX_CHAPTER_CHARS } = CONTENT_PLAN_LIMITS;
  if (target.kind === "cover") {
    const prev = draft.coverImage;
    return {
      ...draft,
      coverImage: {
        id: prev?.id ?? makeSlotId(),
        status: "generated",
        imageAssetRef: image.imageAssetRef,
        imagePrompt: image.imagePrompt ?? null,
        aspect: image.aspect,
        width: prev?.width ?? 100,
        align: prev?.align ?? "center",
        wrap: prev?.wrap ?? false,
        contextPrompt: image.contextPrompt ?? prev?.contextPrompt ?? "",
      },
    };
  }
  if (target.kind === "slot") {
    return mapChapter(draft, target.chapterId, (c) => ({
      ...c,
      images: c.images.map((s) =>
        s.id === target.slotId
          ? { ...s, status: "generated" as const, imageAssetRef: image.imageAssetRef, imagePrompt: image.imagePrompt ?? null, aspect: image.aspect }
          : s,
      ),
    }));
  }
  // "new"
  return mapChapter(draft, target.chapterId, (c) => {
    if (c.images.length >= MAX_IMAGES_PER_CHAPTER) return c;
    const slot: EbookImageSlot = {
      id: makeSlotId(),
      status: "generated",
      imageAssetRef: image.imageAssetRef,
      imagePrompt: image.imagePrompt ?? null,
      aspect: image.aspect,
      width: 100,
      align: "center",
      wrap: false,
      contextPrompt: image.contextPrompt ?? "",
    };
    const anchor = buildImageAnchor(slot.id);
    if (c.bodyHtml.length + anchor.length > MAX_CHAPTER_CHARS) return c;
    return { ...c, bodyHtml: `${c.bodyHtml}${anchor}`, images: [...c.images, slot] };
  });
}

/** True if the persisted draft actually references `ref` at the target — used to detect a
 *  mutate that no-op'd (target full / removed) so the caller can clean up the orphan asset. */
export function draftHasImageRef(draft: EbookDoc, target: EbookImageTarget, ref: string): boolean {
  if (target.kind === "cover") return draft.coverImage?.imageAssetRef === ref;
  const chapter = draft.chapters.find((c) => c.id === target.chapterId);
  if (!chapter) return false;
  if (target.kind === "slot") return chapter.images.find((s) => s.id === target.slotId)?.imageAssetRef === ref;
  return chapter.images.some((s) => s.imageAssetRef === ref); // "new" (refs are unique uuids)
}

/**
 * Extract + validate ops from a model reply. The chat prompt asks the model to emit a fenced
 * ```ops JSON block of the shape {"ops":[…]}; we pull the first fenced block (or the first
 * bare JSON object) and keep only ops that pass `EbookOpSchema`. Returns [] when there are none.
 */
export function extractEbookOps(reply: string): EbookOp[] {
  const raw = extractOpsJson(reply);
  if (!raw || !Array.isArray(raw.ops)) return [];
  const ops: EbookOp[] = [];
  for (const candidate of raw.ops) {
    const parsed = EbookOpSchema.safeParse(candidate);
    if (parsed.success) ops.push(parsed.data);
  }
  return ops;
}

function extractOpsJson(reply: string): { ops?: unknown[] } | null {
  // Prefer a fenced ```ops / ```json block; fall back to the first {...} slice.
  const fence = reply.match(/```(?:ops|json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : reply) ?? "";
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(body.slice(start, end + 1));
    return obj && typeof obj === "object" ? (obj as { ops?: unknown[] }) : null;
  } catch {
    return null;
  }
}
