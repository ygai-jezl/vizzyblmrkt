"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CONTENT_PLAN_LIMITS, type ContentNode } from "@/lib/types/contentPlan";
import {
  EMAIL_BLOCK_KINDS,
  MAX_EMAIL_BLOCKS,
  blockKindLabel,
  ensureFooterLast,
  type EmailBlock,
  type EmailBlockKind,
  type EmailLayout,
} from "@/lib/types/emailLayout";
import type { EmailTemplate } from "@/lib/types/emailTemplate";
import { wrap, renderEmailLayout } from "@/lib/email/emailRender";
import { Modal } from "@/components/admin/email/Modal";
import { imageModelOverride, type ImageModelSlug } from "@/lib/content/create/imageModels";
import { seedLayoutFromNode, defaultBlock, newBlockId } from "./seedLayout";
import { PRESET_EMAIL_TEMPLATES } from "./presetTemplates";
import { TextBlockEditor } from "./TextBlockEditor";
import { BlockSettings } from "./BlockSettings";

/**
 * Visual email-layout editor. Opens as a LEFT-anchored overlay over the Create canvas
 * (leaves the 640px right inspector visible on lg+ screens). Edits the selected email
 * node's block layout; a sandboxed iframe preview renders exactly what will be sent
 * (shared wrap()/renderEmailLayout with the send path). Save writes back the layout +
 * its rendered body; layouts can be saved/loaded as reusable Email Templates.
 */

/** Re-key a loaded template/preset's blocks + guarantee exactly one copy block. Honour
 *  the template's DESIGNATED copy block (a text block flagged role:"copy") so its author's
 *  intent survives; else the first text block; else synthesize one — so Regenerate always
 *  has somewhere to write. */
function adoptLayout(layout: EmailLayout): EmailLayout {
  const blocks: EmailBlock[] = layout.blocks.map(
    (b) => ({ ...b, id: newBlockId(b.kind), role: undefined }) as EmailBlock,
  );
  // Indices align 1:1 with the source layout (map preserves order), so a copy index found
  // in the original is valid here after roles were stripped.
  let copyIdx = layout.blocks.findIndex((b) => b.role === "copy" && b.kind === "text");
  if (copyIdx < 0) copyIdx = blocks.findIndex((b) => b.kind === "text");
  if (copyIdx < 0) {
    blocks.unshift({ ...defaultBlock("text"), role: "copy" } as EmailBlock);
    copyIdx = 0;
  }
  blocks[copyIdx] = { ...blocks[copyIdx], role: "copy" } as EmailBlock;
  // Guarantee the mandatory footer (exactly one, pinned last).
  return ensureFooterLast({ ...layout, blocks });
}

export function EmailLayoutEditor({
  node,
  workspaceId,
  planId,
  onSave,
  onClose,
}: {
  node: ContentNode;
  workspaceId: string;
  planId: string;
  onSave: (layout: EmailLayout, body: string) => void;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<EmailLayout>(() => seedLayoutFromNode(node));
  const [selectedId, setSelectedId] = useState<string | null>(layout.blocks[0]?.id ?? null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [templateModal, setTemplateModal] = useState<null | "save" | "load">(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [nlBrief, setNlBrief] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function generateImageUrl(brief: string, model: ImageModelSlug): Promise<string | null> {
    const res = await fetch(
      `/api/admin/workspace/${workspaceId}/content-plans/${planId}/nodes/${node.id}/image`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send `model` only when changed from this surface's default (see imageModelOverride).
        body: JSON.stringify({ brief, model: imageModelOverride(model, "email") }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as { imageUrl?: string };
    return res.ok && data.imageUrl ? data.imageUrl : null;
  }

  async function generateFromNL() {
    if (!nlBrief.trim()) return;
    setNlBusy(true);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/admin/workspace/${workspaceId}/content-plans/${planId}/nodes/${node.id}/layout`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brief: nlBrief.trim() }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { layout?: EmailLayout };
      if (res.ok && data.layout) {
        const next = ensureFooterLast(data.layout);
        setLayout(next);
        setSelectedId(next.blocks[0]?.id ?? null);
        setMsg("Layout generated — review and save.");
        setNlBrief("");
      } else {
        setMsg("Couldn't generate a layout — try rephrasing.");
      }
    } finally {
      setNlBusy(false);
    }
  }

  // Preview substitutes the footer's internal tokens with friendly placeholders
  // (they're resolved per-recipient at send, not author-editable).
  const previewHtml = useMemo(
    () =>
      wrap(renderEmailLayout(layout), null)
        .replaceAll("{{sender_brand}}", "Your Brand")
        .replaceAll("{{manage_preferences_url}}", "#")
        .replaceAll("{{unsubscribe_url}}", "#")
        .replaceAll("{{privacy_url}}", "#"),
    [layout],
  );
  const selected = layout.blocks.find((b) => b.id === selectedId) ?? null;

  function addBlock(kind: EmailBlockKind) {
    // The footer is mandatory + auto-managed — never added from the palette.
    if (kind === "footer") return;
    if (layout.blocks.length >= MAX_EMAIL_BLOCKS) {
      setMsg(`Max ${MAX_EMAIL_BLOCKS} blocks.`);
      return;
    }
    const b = defaultBlock(kind);
    // Insert BEFORE the trailing footer so the footer always stays last.
    setLayout((l) => {
      const footerIdx = l.blocks.findIndex((x) => x.kind === "footer");
      const blocks = [...l.blocks];
      if (footerIdx >= 0) blocks.splice(footerIdx, 0, b);
      else blocks.push(b);
      return { ...l, blocks };
    });
    setSelectedId(b.id);
  }
  function updateBlock(id: string, patch: Partial<EmailBlock>) {
    setLayout((l) => ({
      ...l,
      blocks: l.blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as EmailBlock) : b)),
    }));
  }
  function deleteBlock(id: string) {
    setLayout((l) => {
      const removed = l.blocks.find((b) => b.id === id);
      // The footer is mandatory and can't be removed.
      if (removed?.kind === "footer") return l;
      let blocks = l.blocks.filter((b) => b.id !== id);
      // If we removed the AI copy block, promote the first remaining text block so
      // Regenerate always has a target (the copy-block invariant).
      if (removed?.role === "copy" && !blocks.some((b) => b.role === "copy")) {
        const firstText = blocks.find((b) => b.kind === "text");
        if (firstText) blocks = blocks.map((b) => (b.id === firstText.id ? ({ ...b, role: "copy" } as EmailBlock) : b));
      }
      return { ...l, blocks };
    });
    if (selectedId === id) setSelectedId(null);
  }
  function moveBlock(id: string, dir: -1 | 1) {
    setLayout((l) => {
      const i = l.blocks.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= l.blocks.length) return l;
      // The footer is pinned last: it can't move, and no block can swap past it.
      if (l.blocks[i]!.kind === "footer" || l.blocks[j]!.kind === "footer") return l;
      const blocks = [...l.blocks];
      [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
      return { ...l, blocks };
    });
  }
  function markCopy(id: string) {
    setLayout((l) => ({
      ...l,
      blocks: l.blocks.map((b) => ({ ...b, role: b.id === id ? "copy" : undefined }) as EmailBlock),
    }));
  }

  async function openLoad() {
    setTemplateModal("load");
    try {
      const res = await fetch(`/api/admin/workspace/${workspaceId}/email-templates`);
      const data = (await res.json().catch(() => ({}))) as { templates?: EmailTemplate[] };
      setTemplates(data.templates ?? []);
    } catch {
      setTemplates([]);
    }
  }
  async function saveTemplate() {
    if (!templateName.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/workspace/${workspaceId}/email-templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: templateName.trim(), layout }),
      });
      setMsg(res.ok ? "Template saved." : "Save failed.");
    } finally {
      setBusy(false);
      setTemplateModal(null);
      setTemplateName("");
    }
  }
  /** Adopt a layout (saved template OR built-in starter) into the editor. */
  function applyLayout(source: EmailLayout) {
    const adopted = adoptLayout(source);
    setLayout(adopted);
    setSelectedId(adopted.blocks[0]?.id ?? null);
    setTemplateModal(null);
  }

  function handleSave() {
    const body = renderEmailLayout(layout);
    // The email body is capped (ContentNode.body max); refuse a save that would produce
    // truncated HTML rather than silently corrupting/failing the persist.
    if (body.length > CONTENT_PLAN_LIMITS.MAX_BODY_CHARS) {
      setMsg(
        `Email is too large (${body.length.toLocaleString()} of ${CONTENT_PLAN_LIMITS.MAX_BODY_CHARS.toLocaleString()} chars) — shorten or remove some blocks.`,
      );
      return;
    }
    onSave(layout, body);
  }

  const HEADER_BTN =
    "rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900";

  return (
    <div className="fixed inset-y-0 left-0 right-0 z-30 flex flex-col bg-white shadow-2xl dark:bg-neutral-950 lg:right-[640px]">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
        <div className="text-sm font-semibold">Email Layout</div>
        <div className="ml-2 flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700">
          {(["edit", "preview"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-xs capitalize ${tab === t ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : ""}`}
            >
              {t}
            </button>
          ))}
        </div>
        {tab === "preview" ? (
          <div className="flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700">
            {(["desktop", "mobile"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDevice(d)}
                className={`px-3 py-1 text-xs capitalize ${device === d ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : ""}`}
              >
                {d}
              </button>
            ))}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {msg ? <span className="text-xs text-neutral-500">{msg}</span> : null}
          <button type="button" onClick={openLoad} className={HEADER_BTN}>
            Load template
          </button>
          <button type="button" onClick={() => setTemplateModal("save")} className={HEADER_BTN}>
            Save as template
          </button>
          <button type="button" onClick={onClose} className={HEADER_BTN}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
          >
            Save
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Palette */}
        <div className="w-40 shrink-0 space-y-1 overflow-y-auto border-r border-neutral-200 p-2 dark:border-neutral-800">
          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Add block</div>
          {EMAIL_BLOCK_KINDS.map((k) =>
            // The footer is always included and can't be added/removed — show it
            // disabled so the user knows it's there and managed automatically.
            k === "footer" ? (
              <button
                key={k}
                type="button"
                disabled
                title="Every email includes the footer automatically — it can't be removed."
                className="block w-full cursor-not-allowed rounded-md border border-dashed border-neutral-200 px-2 py-1.5 text-left text-xs text-neutral-400 dark:border-neutral-800"
              >
                ✓ Footer · required
              </button>
            ) : (
              <button
                key={k}
                type="button"
                onClick={() => addBlock(k)}
                className="block w-full rounded-md border border-neutral-200 px-2 py-1.5 text-left text-xs hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                + {blockKindLabel(k)}
              </button>
            ),
          )}
        </div>

        {/* Edit surface OR preview */}
        <div className="flex-1 overflow-y-auto bg-neutral-50 p-4 dark:bg-neutral-900/40">
          {tab === "edit" ? (
            <div className="mx-auto max-w-[560px] space-y-2">
              {layout.blocks.length === 0 ? (
                <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
                  Add a block from the left to start building.
                </p>
              ) : null}
              {layout.blocks.map((block, i) => (
                <BlockCard
                  key={block.id}
                  block={block}
                  selected={block.id === selectedId}
                  isFirst={i === 0}
                  // Can't move down INTO the footer's last slot.
                  isLast={i === layout.blocks.length - 1 || layout.blocks[i + 1]?.kind === "footer"}
                  onSelect={() => setSelectedId(block.id)}
                  onChange={(patch) => updateBlock(block.id, patch)}
                  onMove={(dir) => moveBlock(block.id, dir)}
                  onDelete={() => deleteBlock(block.id)}
                  onMarkCopy={() => markCopy(block.id)}
                />
              ))}
            </div>
          ) : (
            <div className="mx-auto" style={{ maxWidth: device === "mobile" ? 375 : 620 }}>
              <iframe
                srcDoc={previewHtml}
                sandbox=""
                title="Email preview"
                className="h-[70vh] w-full rounded-md border border-neutral-200 bg-white dark:border-neutral-800"
              />
            </div>
          )}
        </div>

        {/* Settings */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-neutral-200 dark:border-neutral-800">
          <BlockSettings
            block={selected}
            onChange={(patch) => selected && updateBlock(selected.id, patch)}
            onGenerateImage={generateImageUrl}
          />
        </div>
      </div>

      {/* Docked AI prompt bar — describe the email, generate a full layout. */}
      <div className="flex items-center gap-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className="text-sm">✨</span>
        <input
          value={nlBrief}
          onChange={(e) => setNlBrief(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !nlBusy) generateFromNL();
          }}
          placeholder="Describe the email you want — e.g. a bold welcome with a hero image and a Get Started button"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="button"
          onClick={generateFromNL}
          disabled={nlBusy || !nlBrief.trim()}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {nlBusy ? "Generating…" : "Generate"}
        </button>
      </div>

      {/* Modals are portalled to <body> so their z-50 escapes this z-30 overlay's
          stacking context (otherwise the z-40 inspector would paint over them). */}
      {createPortal(
        <>
      {/* Save-as-template modal */}
      <Modal open={templateModal === "save"} onClose={() => setTemplateModal(null)} title="Save as email template">
        <div className="space-y-3">
          <input
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder="Template name"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="button"
            onClick={saveTemplate}
            disabled={busy || !templateName.trim()}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {busy ? "Saving…" : "Save template"}
          </button>
        </div>
      </Modal>

      {/* Load-template modal — built-in starters first, then this workspace's saved ones. */}
      <Modal open={templateModal === "load"} onClose={() => setTemplateModal(null)} title="Load an email template">
        <div className="space-y-4">
          <div>
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              Starter templates
            </div>
            <ul className="space-y-1">
              {PRESET_EMAIL_TEMPLATES.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => applyLayout(p.layout)}
                    className="w-full rounded-md border border-neutral-200 px-3 py-2 text-left hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                  >
                    <span className="text-sm font-medium">{p.title}</span>
                    <span className="ml-2 text-xs text-neutral-400">{p.layout.blocks.length} blocks</span>
                    <span className="mt-0.5 block text-xs text-neutral-500">{p.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              Your saved templates
            </div>
            {templates.length === 0 ? (
              <p className="px-1 text-sm text-neutral-500">No saved templates yet.</p>
            ) : (
              <ul className="space-y-1">
                {templates.map((tpl) => (
                  <li key={tpl.id}>
                    <button
                      type="button"
                      onClick={() => applyLayout(tpl.layout)}
                      className="w-full rounded-md border border-neutral-200 px-3 py-2 text-left text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                    >
                      {tpl.title}
                      <span className="ml-2 text-xs text-neutral-400">{tpl.layout.blocks.length} blocks</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Modal>
        </>,
        document.body,
      )}
    </div>
  );
}

/** A single editable block row in the edit surface. */
function BlockCard({
  block,
  selected,
  isFirst,
  isLast,
  onSelect,
  onChange,
  onMove,
  onDelete,
  onMarkCopy,
}: {
  block: EmailBlock;
  selected: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<EmailBlock>) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onMarkCopy: () => void;
}) {
  const CTRL = "rounded px-1.5 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800";
  // The footer is mandatory: no move/delete, only its background is editable.
  const locked = block.kind === "footer";
  return (
    <div
      onClick={onSelect}
      className={`rounded-md border bg-white p-2 dark:bg-neutral-900 ${selected ? "border-neutral-900 dark:border-white" : "border-neutral-200 dark:border-neutral-800"}`}
    >
      <div className="mb-1 flex items-center gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{blockKindLabel(block.kind)}</span>
        {block.role === "copy" ? <span className="rounded-full bg-indigo-100 px-1.5 text-[10px] text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">AI copy</span> : null}
        {locked ? <span className="rounded-full bg-neutral-200 px-1.5 text-[10px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">Required</span> : null}
        {locked ? null : (
          <div className="ml-auto flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
            {block.kind === "text" ? (
              <button type="button" onClick={onMarkCopy} title="Mark as AI copy block" className={CTRL}>
                ★
              </button>
            ) : null}
            <button type="button" onClick={() => onMove(-1)} disabled={isFirst} className={CTRL}>
              ↑
            </button>
            <button type="button" onClick={() => onMove(1)} disabled={isLast} className={CTRL}>
              ↓
            </button>
            <button type="button" onClick={onDelete} className={`${CTRL} text-red-600`}>
              ✕
            </button>
          </div>
        )}
      </div>
      {/* Only the inline TEXT editor swallows clicks (so typing doesn't re-select);
          every other block body bubbles to onSelect so a click anywhere selects it. */}
      <div onClick={block.kind === "text" ? (e) => e.stopPropagation() : undefined}>
        {block.kind === "text" ? (
          <TextBlockEditor html={block.html} onChange={(html) => onChange({ html })} />
        ) : block.kind === "heading" ? (
          <input
            value={block.html}
            onChange={(e) => onChange({ html: e.target.value })}
            placeholder="Heading text"
            className="w-full rounded-md border border-neutral-200 px-2 py-1.5 text-sm font-semibold dark:border-neutral-800 dark:bg-neutral-950"
          />
        ) : (
          <BlockMiniPreview block={block} />
        )}
      </div>
    </div>
  );
}

/** A lightweight non-fidelity representation of a non-text block in the edit list. */
function BlockMiniPreview({ block }: { block: EmailBlock }) {
  switch (block.kind) {
    case "image":
      return block.src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={block.src} alt={block.alt} className="max-h-24 rounded object-contain" />
      ) : (
        <div className="rounded border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-400 dark:border-neutral-700">Image — set a URL in settings →</div>
      );
    case "button":
      return (
        <div style={{ textAlign: block.align }}>
          <span style={{ background: block.bg, color: block.color, borderRadius: block.radius, padding: "8px 16px", fontSize: 13, display: "inline-block" }}>
            {block.label}
          </span>
        </div>
      );
    case "divider":
      return <hr style={{ borderTop: `${block.thickness}px solid ${block.color}` }} className="my-1" />;
    case "spacer":
      return <div className="text-center text-[10px] text-neutral-400">Spacer · {block.height}px</div>;
    case "social":
      return <div className="text-xs text-neutral-500">Social · {block.links.length} link(s)</div>;
    case "footer":
      return (
        <div className="text-center text-[10px] text-neutral-400">
          Sent by your brand · Manage preferences · Unsubscribe · Privacy Policy
        </div>
      );
    default:
      return null;
  }
}
