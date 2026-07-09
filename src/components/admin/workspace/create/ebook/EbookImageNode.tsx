"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";

/**
 * Tiptap atom node for an eBook image placeholder/anchor. Chapters carry inline image
 * SLOTS anchored as `<div data-ebook-image="slotId"></div>`; StarterKit would silently
 * drop that <div> on load and lose the anchor, so we register this node to round-trip it
 * through editing. v1 renders a neutral placeholder card (images aren't generated yet);
 * v2 will enrich the node view with the slot's image / X / Generate actions.
 */
function EbookImageNodeView() {
  return (
    <NodeViewWrapper
      className="my-3 flex items-center justify-center rounded-md border border-dashed border-neutral-300 bg-neutral-50 py-6 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/40"
      data-ebook-image-placeholder=""
    >
      <span aria-hidden>🖼</span>
      <span className="ml-2">Image placeholder</span>
    </NodeViewWrapper>
  );
}

export const EbookImage = Node.create({
  name: "ebookImage",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      slotId: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-ebook-image"),
        renderHTML: (attrs) =>
          attrs.slotId ? { "data-ebook-image": attrs.slotId as string } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-ebook-image]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EbookImageNodeView);
  },
});
