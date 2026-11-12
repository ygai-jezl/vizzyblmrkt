import { createNodeFromContent, getHTMLFromFragment } from "@tiptap/core";
import { Fragment, Node as PMNode, type Schema } from "@tiptap/pm/model";
import { emailEditProblem } from "@/lib/email/emailDoc";
import { sanitizeEmailHtml } from "@/lib/email/emailRender";
import { PlanError, type FragmentMaker } from "@/lib/content/editor/vizzyPlan";
import type { Serializer } from "@/lib/content/editor/vizzySelection";

/**
 * An email's text for Vizzy and back, in the browser (HTML parsing needs a DOM). What Vizzy
 * writes is refused when it has HTML Edit mode can't keep, then sanitized and read with the
 * editor's own rules.
 */

function parse(html: string, schema: Schema): PMNode {
  const node = createNodeFromContent(html, schema, { slice: false, errorOnInvalidContent: true });
  if (!(node instanceof PMNode)) throw new PlanError("Vizzy's version couldn't be placed in the email. Ask again.");
  return node;
}

function checked(html: string): string {
  const kept = emailEditProblem(html);
  if (kept) throw new PlanError(`Vizzy's version has HTML Edit mode can't keep (${kept.join(", ")}), so it wasn't used.`);
  return sanitizeEmailHtml(html);
}

export function emailFragments(schema: Schema): FragmentMaker {
  return {
    inline(text) {
      const html = checked(text.trim());
      if (/<(?:p|ul|ol|li|h[1-6])\b/i.test(html)) {
        throw new PlanError("Vizzy's version has more than one paragraph. Select whole paragraphs to change their shape.");
      }
      const doc = parse(`<p>${html}</p>`, schema);
      return doc.firstChild?.content ?? Fragment.empty;
    },
    blocks(text) {
      const html = checked(text.trim());
      return parse(/^\s*</.test(html) ? html : `<p>${html}</p>`, schema).content;
    },
  };
}

export function emailSerializer(schema: Schema): Serializer {
  return {
    inline: (content) => sanitizeEmailHtml(getHTMLFromFragment(content, schema)),
    blocks: (content) => sanitizeEmailHtml(getHTMLFromFragment(content, schema)),
  };
}
