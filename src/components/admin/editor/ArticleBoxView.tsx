"use client";

import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ArticleBox } from "@/lib/content/editor/extensions";

/** A box in the editor, drawn as the preview draws it, with its label typed in place. */
function ArticleBoxView({ node, updateAttributes, editor }: NodeViewProps) {
  const label = String(node.attrs.label ?? "");
  return (
    <NodeViewWrapper className="mt-5 rounded-lg border border-neutral-300 bg-neutral-50 px-4 py-3 first:mt-0 dark:border-neutral-700 dark:bg-neutral-900">
      <div contentEditable={false}>
        <input
          aria-label="Box label"
          value={label}
          placeholder="Label"
          disabled={!editor.isEditable}
          // A label is bold text in the Markdown, so it can't hold asterisks.
          onChange={(e) => updateAttributes({ label: e.target.value.replace(/\*/g, "") })}
          className="w-full bg-transparent font-bold text-neutral-900 outline-none placeholder:font-normal placeholder:text-neutral-400 dark:text-neutral-100"
        />
      </div>
      <NodeViewContent className="mt-1" />
    </NodeViewWrapper>
  );
}

/** ArticleBox with its editor view. */
export const ArticleBoxWithView = ArticleBox.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ArticleBoxView);
  },
});
