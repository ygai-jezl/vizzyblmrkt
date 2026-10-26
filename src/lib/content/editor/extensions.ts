import { Extension, Mark, Node, mergeAttributes, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TextAlign from "@tiptap/extension-text-align";
import { safeHref } from "@/lib/content/blog/markdown";
import { isSafeHref } from "@/lib/email/emailRender";

/**
 * The editor's schema for each kind of long content, shared by Edit mode and the tests (which
 * check converted documents against it without a browser). The schema holds exactly what the
 * saved format can: an article's Markdown (headings 1 to 4, paragraphs, flat lists, pipe
 * tables, boxes, quotations, code and rules) or an email's sanitized HTML (sanitizeEmailHtml's
 * tags). Pure: no React, so a node view is added by the editor component.
 */
export type EditFormat = "blog" | "newsletter" | "email";

/** The Markdown formats: what is saved is the article's Markdown. */
export function isMarkdownFormat(format: EditFormat): boolean {
  return format !== "email";
}

/** The link targets a format keeps: an article's (`safeHref`), or an email's, which may also be
 *  `mailto:` or a merge value such as `{{hub_url}}`. */
export function linkCheck(format: EditFormat): (raw: string) => string | null {
  if (format === "blog") return safeHref;
  return (raw) => {
    const href = raw.trim();
    return isSafeHref(href) ? href : null;
  };
}

/** A box in an article: a blockquote that opens with a bold label ("Key facts", "TL;DR"). */
export const ArticleBox = Node.create({
  name: "articleBox",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      label: {
        default: "Key facts",
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-box-label") ?? "",
        renderHTML: (attrs) => ({ "data-box-label": String(attrs.label ?? "") }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-box-label]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { class: "yg-edit-box" }),
      ["p", { class: "yg-edit-box-label", contenteditable: "false" }, String(node.attrs.label ?? "")],
      ["div", { class: "yg-edit-box-body" }, 0],
    ];
  },
});

/** `<u>`, which sanitizeEmailHtml keeps, so an email that has it doesn't lose it in Edit mode. */
export const Underline = Mark.create({
  name: "underline",
  parseHTML() {
    return [{ tag: "u" }];
  },
  renderHTML() {
    return ["u", 0];
  },
});

/** Inline code that, unlike Tiptap's, can sit inside a link or bold text, as Markdown's can. */
export const InlineCode = Mark.create({
  name: "code",
  code: true,
  parseHTML() {
    return [{ tag: "code" }];
  },
  renderHTML() {
    return ["code", 0];
  },
});

/** Markdown lists are flat: Tab doesn't indent a list item (it would nest it). */
const FlatLists = Extension.create({
  name: "flatLists",
  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.isActive("listItem"),
      "Shift-Tab": () => this.editor.isActive("listItem"),
    };
  },
});

/** A Markdown table cell is one line, so a cell holds a single paragraph. */
const OneLineHeader = TableHeader.extend({ content: "paragraph" });
const OneLineCell = TableCell.extend({ content: "paragraph" });

/** The extensions for a format. `box` replaces ArticleBox (the editor passes one with a node view). */
export function editorExtensions(format: EditFormat, box: typeof ArticleBox = ArticleBox): Extensions {
  const check = linkCheck(format);
  const link = Link.configure({
    openOnClick: false,
    autolink: true,
    isAllowedUri: (url) => check(url) !== null,
  });

  if (format === "email") {
    return [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
      }),
      Underline,
      // Keeps a centred line; the toolbar doesn't set alignment.
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      link,
    ];
  }

  // A newsletter's toolbar offers less, but its schema is the article's: Vizzy may have written a
  // table or a box into it, and the schema must hold whatever the Markdown already has.
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      code: false,
      hardBreak: false,
      strike: false,
    }),
    InlineCode,
    link,
    Table.configure({ resizable: false }),
    TableRow,
    OneLineHeader,
    OneLineCell,
    box,
    FlatLists,
  ];
}
