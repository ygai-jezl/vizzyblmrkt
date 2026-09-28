"use client";

import { useState } from "react";
import type { EmailBlock } from "@/lib/types/emailLayout";
import { SOCIAL_PLATFORMS } from "@/lib/types/emailLayout";
import { DEFAULT_IMAGE_MODEL_SLUG, type ImageModelSlug } from "@/lib/content/create/imageModels";
import { layoutButtonLook } from "@/lib/email/emailRender";
import { accentFor, type ResolvedEmailStyle } from "@/lib/email/emailStyle";
import { ImageModelSelect } from "@/components/admin/ImageModelSelect";
import {
  buttonColourSource,
  buttonPickerPatch,
  buttonSourcePatch,
  themeButtonShape,
  type ButtonColourSource,
} from "./buttonColour";

/**
 * Settings panel for the selected block. Text/heading COPY is edited inline in the
 * block card; this panel edits the structural props (level, align, image src, button
 * colours, etc). onChange receives a shallow patch merged into the block.
 *
 * Where layout buttons follow the Email style (its `layouts` bit), a button has a Colour
 * switch: Email style (the button colour, an automatic label and the theme's shape; the
 * pickers are hidden) or Own colour (the pickers, with the colours it was built with).
 * Touching a picker pins it to Own colour. Without the bit it's as it always was.
 */
const FIELD = "w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const LABEL = "block text-xs font-medium text-neutral-600 dark:text-neutral-300";

/** A colour that can be cleared back to null (default / transparent). */
function NullableColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
}) {
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="color"
          value={value ?? "#ffffff"}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-12 rounded border border-neutral-300 dark:border-neutral-700"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
          >
            Clear
          </button>
        ) : (
          <span className="text-xs text-neutral-400">default / none</span>
        )}
      </div>
    </div>
  );
}

function AlignPicker({ value, onChange }: { value: string; onChange: (v: "left" | "center" | "right") => void }) {
  return (
    <div className="flex gap-1">
      {(["left", "center", "right"] as const).map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => onChange(a)}
          className={`flex-1 rounded border px-2 py-1 text-xs capitalize ${
            value === a
              ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          {a}
        </button>
      ))}
    </div>
  );
}

/** A button's Colour switch: the Email style's button colour (with its swatch) or its own. */
function ColourSourcePicker({
  value,
  accent,
  onChange,
}: {
  value: ButtonColourSource;
  accent: string | null;
  onChange: (v: ButtonColourSource) => void;
}) {
  const options: { id: ButtonColourSource; label: string }[] = [
    { id: "email_style", label: "Email style" },
    { id: "own", label: "Own colour" },
  ];
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded border px-2 py-1 text-xs ${
            value === o.id
              ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          {o.id === "email_style" && accent ? (
            <span aria-hidden className="inline-block h-3 w-3 rounded-sm border border-neutral-300" style={{ background: accent }} />
          ) : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Brief input + "✨ Generate image" for an image block (keyed per block by the parent). */
function ImageGenControls({
  onGenerate,
  onApply,
}: {
  onGenerate: (brief: string, model: ImageModelSlug) => Promise<string | null>;
  onApply: (url: string) => void;
}) {
  const [brief, setBrief] = useState("");
  // Per-generation image model (defaults to this surface's current model — lite).
  const [model, setModel] = useState<ImageModelSlug>(DEFAULT_IMAGE_MODEL_SLUG.email);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-1 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
      <div className={LABEL}>Generate with AI</div>
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={2}
        placeholder="Describe the image (on-brand; text-free unless you ask for words)…"
        className={`${FIELD} text-xs`}
      />
      <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        Model
        <ImageModelSelect value={model} onChange={setModel} className={`${FIELD} text-xs`} />
      </label>
      <button
        type="button"
        disabled={busy || !brief.trim()}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const url = await onGenerate(brief.trim(), model);
            if (url) onApply(url);
            else setErr("Couldn't generate — try again.");
          } finally {
            setBusy(false);
          }
        }}
        className="w-full rounded-md bg-neutral-900 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
      >
        {busy ? "Generating…" : "✨ Generate image"}
      </button>
      {err ? <p className="text-xs text-red-600">{err}</p> : null}
    </div>
  );
}

export function BlockSettings({
  block,
  emailStyle = null,
  onChange,
  onGenerateImage,
}: {
  block: EmailBlock | null;
  /** The tenant's resolved Email style; with its `layouts` bit, buttons get the Colour switch. */
  emailStyle?: ResolvedEmailStyle | null;
  onChange: (patch: Partial<EmailBlock>) => void;
  onGenerateImage?: (brief: string, model: ImageModelSlug) => Promise<string | null>;
}) {
  if (!block) {
    return <p className="p-3 text-xs text-neutral-500">Select a block to edit its settings.</p>;
  }
  // A button's Colour switch (null = none), and what it draws while it follows the Email style.
  const source = block.kind === "button" ? buttonColourSource(block, emailStyle) : null;
  const look = block.kind === "button" ? layoutButtonLook(block, emailStyle) : null;
  const themeShape = look?.follows ? themeButtonShape(emailStyle) : null;

  return (
    <div className="space-y-3 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{block.kind}</div>

      {/* Per-section colours (every block). */}
      <NullableColorField
        label="Section background"
        value={block.sectionBg}
        onChange={(v) => onChange({ sectionBg: v })}
      />
      {block.kind === "text" || block.kind === "heading" ? (
        <NullableColorField label="Text colour" value={block.color} onChange={(v) => onChange({ color: v })} />
      ) : null}

      {block.kind === "text" ? (
        <p className="text-xs text-neutral-500">Edit the text directly in the block above.</p>
      ) : null}

      {block.kind === "footer" ? (
        <p className="text-xs text-neutral-500">
          This footer is <span className="font-medium">required on every email</span> — “sent by”
          your verified-domain brand, plus Manage preferences, Unsubscribe and Privacy Policy.
          Its content is fixed; you can only change its background colour above.
        </p>
      ) : null}

      {block.kind === "heading" ? (
        <>
          <label className={LABEL}>
            Level
            <select
              value={block.level}
              onChange={(e) => onChange({ level: Number(e.target.value) as 1 | 2 | 3 })}
              className={`mt-1 ${FIELD}`}
            >
              <option value={1}>H1 — Large</option>
              <option value={2}>H2 — Medium</option>
              <option value={3}>H3 — Small</option>
            </select>
          </label>
          <div>
            <div className={LABEL}>Align</div>
            <div className="mt-1">
              <AlignPicker value={block.align} onChange={(align) => onChange({ align })} />
            </div>
          </div>
        </>
      ) : null}

      {block.kind === "image" ? (
        <>
          {onGenerateImage ? (
            <ImageGenControls key={block.id} onGenerate={onGenerateImage} onApply={(url) => onChange({ src: url })} />
          ) : null}
          <label className={LABEL}>
            Image URL
            <input value={block.src} onChange={(e) => onChange({ src: e.target.value })} placeholder="https://…" className={`mt-1 ${FIELD}`} />
          </label>
          <label className={LABEL}>
            Alt text
            <input value={block.alt} onChange={(e) => onChange({ alt: e.target.value })} className={`mt-1 ${FIELD}`} />
          </label>
          <label className={LABEL}>
            Link (optional)
            <input value={block.href ?? ""} onChange={(e) => onChange({ href: e.target.value || null })} placeholder="https://… or {{token}}" className={`mt-1 ${FIELD}`} />
          </label>
          <label className={LABEL}>
            Width ({block.width}px)
            <input type="range" min={100} max={560} value={block.width} onChange={(e) => onChange({ width: Number(e.target.value) })} className="mt-1 w-full" />
          </label>
          <div>
            <div className={LABEL}>Align</div>
            <div className="mt-1">
              <AlignPicker value={block.align} onChange={(align) => onChange({ align })} />
            </div>
          </div>
        </>
      ) : null}

      {block.kind === "button" ? (
        <>
          <label className={LABEL}>
            Label
            <input value={block.label} onChange={(e) => onChange({ label: e.target.value })} className={`mt-1 ${FIELD}`} />
          </label>
          <label className={LABEL}>
            Link
            <input value={block.href} onChange={(e) => onChange({ href: e.target.value })} placeholder="https://… or {{token}}" className={`mt-1 ${FIELD}`} />
          </label>
          {source ? (
            <div>
              <div className={LABEL}>Colour</div>
              <div className="mt-1">
                <ColourSourcePicker
                  value={source}
                  accent={accentFor(emailStyle, "button")}
                  onChange={(v) => onChange(buttonSourcePatch(v))}
                />
              </div>
              {look?.follows ? (
                <p className="mt-1 text-xs text-neutral-500">
                  Label: {look.color === "#000000" ? "black" : "white"}, automatic
                </p>
              ) : null}
            </div>
          ) : null}
          {look?.follows ? null : (
            <div className="grid grid-cols-2 gap-2">
              <label className={LABEL}>
                Background
                <input type="color" value={block.bg} onChange={(e) => onChange(buttonPickerPatch({ bg: e.target.value }, emailStyle))} className="mt-1 h-8 w-full rounded border border-neutral-300 dark:border-neutral-700" />
              </label>
              <label className={LABEL}>
                Text
                <input type="color" value={block.color} onChange={(e) => onChange(buttonPickerPatch({ color: e.target.value }, emailStyle))} className="mt-1 h-8 w-full rounded border border-neutral-300 dark:border-neutral-700" />
              </label>
            </div>
          )}
          {themeShape ? (
            // Following a theme other than Classic, the button takes the theme's shape, so its own corners don't show.
            <p className="text-xs text-neutral-500">Corners: {themeShape}, from your Email style&rsquo;s theme</p>
          ) : (
            <label className={LABEL}>
              Corner radius ({block.radius}px)
              <input type="range" min={0} max={40} value={block.radius} onChange={(e) => onChange({ radius: Number(e.target.value) })} className="mt-1 w-full" />
            </label>
          )}
          <div>
            <div className={LABEL}>Align</div>
            <div className="mt-1">
              <AlignPicker value={block.align} onChange={(align) => onChange({ align })} />
            </div>
          </div>
        </>
      ) : null}

      {block.kind === "divider" ? (
        <>
          <label className={LABEL}>
            Colour
            <input type="color" value={block.color} onChange={(e) => onChange({ color: e.target.value })} className="mt-1 h-8 w-full rounded border border-neutral-300 dark:border-neutral-700" />
          </label>
          <label className={LABEL}>
            Thickness ({block.thickness}px)
            <input type="range" min={1} max={8} value={block.thickness} onChange={(e) => onChange({ thickness: Number(e.target.value) })} className="mt-1 w-full" />
          </label>
        </>
      ) : null}

      {block.kind === "spacer" ? (
        <label className={LABEL}>
          Height ({block.height}px)
          <input type="range" min={4} max={120} value={block.height} onChange={(e) => onChange({ height: Number(e.target.value) })} className="mt-1 w-full" />
        </label>
      ) : null}

      {block.kind === "social" ? (
        <>
          <div>
            <div className={LABEL}>Align</div>
            <div className="mt-1">
              <AlignPicker value={block.align} onChange={(align) => onChange({ align })} />
            </div>
          </div>
          <div className="space-y-2">
            {block.links.map((link, i) => (
              <div key={i} className="flex items-center gap-1">
                <select
                  value={link.platform}
                  onChange={(e) => {
                    const links = block.links.map((l, j) => (j === i ? { ...l, platform: e.target.value as (typeof SOCIAL_PLATFORMS)[number] } : l));
                    onChange({ links });
                  }}
                  className={FIELD}
                  style={{ width: "36%" }}
                >
                  {SOCIAL_PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  value={link.url}
                  onChange={(e) => {
                    const links = block.links.map((l, j) => (j === i ? { ...l, url: e.target.value } : l));
                    onChange({ links });
                  }}
                  placeholder="https://…"
                  className={FIELD}
                />
                <button
                  type="button"
                  onClick={() => onChange({ links: block.links.filter((_, j) => j !== i) })}
                  className="rounded border border-neutral-300 px-2 py-1 text-xs text-red-600 dark:border-neutral-700"
                >
                  ✕
                </button>
              </div>
            ))}
            {block.links.length < 8 ? (
              <button
                type="button"
                onClick={() => onChange({ links: [...block.links, { platform: "website" as const, url: "" }] })}
                className="w-full rounded border border-dashed border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                + Add link
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
