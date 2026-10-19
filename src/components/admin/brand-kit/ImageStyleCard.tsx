"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  IMAGE_STYLE_CHANNELS,
  ImageStyleInputSchema,
  type ImageStyleChannel,
  type ImageStyleId,
  type ImageStyleInput,
  type StoredImageStyle,
} from "@/lib/types/imageStyle";
import { IMAGE_STYLES, imageStyleById } from "@/lib/content/imageStyle/catalogue";
import { ImageStyleSwatch } from "./ImageStyleSwatch";

/** Vizzy's pending suggestion as the page shows it (who asked stays on the server). */
export interface PendingImageStyleSuggestion {
  defaultStyleId: ImageStyleId;
  channels?: Partial<Record<ImageStyleChannel, ImageStyleId>>;
  reason: string;
  suggestedAt: string;
}

const CHANNEL_LABELS: Record<ImageStyleChannel, string> = {
  blogHero: "Blog hero",
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
  newsletter: "Newsletter images",
  ebook: "eBook images",
  launchEmail: "Launch email hero",
};

/** Channels a template style can be made for (the others take its model twin). */
const TEMPLATE_CHANNELS: ReadonlySet<ImageStyleChannel> = new Set(["blogHero", "linkedin", "x", "instagram"]);

function toDraft(s: StoredImageStyle | null): ImageStyleInput {
  const channels = Object.fromEntries(
    Object.entries(s?.channels ?? {}).filter(([, v]) => typeof v === "string"),
  ) as ImageStyleInput["channels"];
  return {
    defaultStyleId: s?.defaultStyleId ?? null,
    channels,
    accentHex: s?.accentHex ?? null,
    logoOnSocial: s?.logoOnSocial ?? true,
    headlineOnSocial: s?.headlineOnSocial ?? true,
  };
}

/**
 * Brand › Image style: the look every new image starts from. A default, an optional style per
 * channel, the accent, and whether social images carry the logo and the headline. Members see
 * it; admins save. Any single image can still pick another style when it's made.
 */
export function ImageStyleCard({
  initial,
  suggestion,
  palette,
  canEdit,
}: {
  initial: StoredImageStyle | null;
  suggestion: PendingImageStyleSuggestion | null;
  palette: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<StoredImageStyle | null>(initial);
  const [draft, setDraft] = useState<ImageStyleInput>(() => toDraft(initial));
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [handled, setHandled] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "reset" | "dismiss">(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const check = useMemo(() => ImageStyleInputSchema.safeParse(draft), [draft]);
  const disabled = !canEdit || busy !== null;
  const defaultLabel = imageStyleById(draft.defaultStyleId)?.label ?? "Today's presets";
  const pending = suggestion && suggestion.suggestedAt !== handled ? suggestion : null;

  function pick(id: ImageStyleId) {
    setDraft((d) => ({ ...d, defaultStyleId: id }));
    setStatus(null);
  }

  function setChannel(key: ImageStyleChannel, value: string) {
    setDraft((d) => {
      const channels = { ...d.channels };
      if (value) channels[key] = value as ImageStyleId;
      else delete channels[key];
      return { ...d, channels };
    });
    setStatus(null);
  }

  function review(s: PendingImageStyleSuggestion) {
    setDraft((d) => ({ ...d, defaultStyleId: s.defaultStyleId, channels: { ...d.channels, ...(s.channels ?? {}) } }));
    setReviewing(s.suggestedAt);
    setStatus("Vizzy's suggestion is shown below. Save to use it.");
  }

  async function dismiss(s: PendingImageStyleSuggestion) {
    setBusy("dismiss");
    setError(null);
    try {
      const res = await fetch("/api/admin/brand-kit/image-style/suggestion", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestedAt: s.suggestedAt }),
      });
      const data = (await res.json().catch(() => ({}))) as { cleared?: boolean };
      if (!res.ok) {
        setError(res.status === 403 ? "Only an admin can dismiss a suggestion." : "Couldn't dismiss. Try again.");
        return;
      }
      setHandled(s.suggestedAt);
      if (reviewing === s.suggestedAt) {
        setReviewing(null);
        setDraft(toDraft(saved));
      }
      if (data.cleared) setStatus("Suggestion dismissed. Your image style hasn't changed.");
      else router.refresh();
    } catch {
      setError("Couldn't dismiss. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!check.success) return;
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/brand-kit/image-style", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reviewing ? { ...check.data, fromSuggestion: reviewing } : check.data),
      });
      const data = (await res.json().catch(() => ({}))) as { imageStyle?: StoredImageStyle; issues?: Array<{ message: string }> };
      if (!res.ok || !data.imageStyle) {
        setError(res.status === 403 ? "Only an admin can change the image style." : (data.issues?.[0]?.message ?? "Couldn't save. Try again."));
        return;
      }
      setSaved(data.imageStyle);
      setDraft(toDraft(data.imageStyle));
      if (reviewing) {
        setHandled(reviewing);
        router.refresh();
      }
      setReviewing(null);
      setStatus("Saved. New images start from this style. Any image can still switch when it's made.");
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!window.confirm("Reset? New images go back to today's style presets.")) return;
    setBusy("reset");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/brand-kit/image-style", { method: "DELETE" });
      if (!res.ok) {
        setError(res.status === 403 ? "Only an admin can change the image style." : "Couldn't reset. Try again.");
        return;
      }
      setSaved(null);
      setDraft(toDraft(null));
      setReviewing(null);
      setStatus("Reset. New images use today's style presets.");
    } catch {
      setError("Couldn't reset. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {pending ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
          <span className="min-w-0 flex-1">
            <b>Vizzy suggests {imageStyleById(pending.defaultStyleId)?.label ?? "a style"}.</b> {pending.reason}
          </span>
          {canEdit ? (
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => review(pending)}
                disabled={busy !== null}
                className="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                Review
              </button>
              <button
                type="button"
                onClick={() => dismiss(pending)}
                disabled={busy !== null}
                className="rounded-md border border-blue-200 px-3 py-1.5 font-medium dark:border-blue-800"
              >
                Dismiss
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="text-sm font-semibold">Default style</h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Create and Vizzy start every image from it. Anyone making an image can pick another for that image only.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {IMAGE_STYLES.map((s) => {
            const on = draft.defaultStyleId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                disabled={disabled || !s.built}
                onClick={() => pick(s.id)}
                className={`flex flex-col gap-2 rounded-lg border-2 p-2 text-left transition-colors disabled:cursor-not-allowed ${
                  on
                    ? "border-blue-600 bg-blue-50 dark:bg-blue-950/40"
                    : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800"
                } ${s.built ? "" : "opacity-50"}`}
              >
                <ImageStyleSwatch id={s.id} className="aspect-video w-full" />
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    <span className="mr-1 font-mono text-xs text-neutral-500">{s.number}</span>
                    {s.label}
                  </span>
                  {on ? (
                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700 dark:bg-blue-900 dark:text-blue-200">Default</span>
                  ) : !s.built ? (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800">Coming</span>
                  ) : null}
                </span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {s.engine === "template" ? "Template: words and numbers exact" : "Image model: no words in the art"}
                </span>
              </button>
            );
          })}
        </div>
        {canEdit && draft.defaultStyleId && imageStyleById(draft.defaultStyleId)?.engine === "template" && imageStyleById(draft.defaultStyleId)?.built ? (
          <figure className="space-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={`${draft.defaultStyleId}${draft.accentHex ?? ""}${draft.logoOnSocial}`}
              src={`/api/admin/brand-kit/image-style/preview?styleId=${draft.defaultStyleId}&size=share&logo=${draft.logoOnSocial ? 1 : 0}${draft.accentHex ? `&accent=${encodeURIComponent(draft.accentHex)}` : ""}`}
              alt={`${defaultLabel} drawn with your logo, fonts and accent`}
              className="aspect-[1200/630] w-full max-w-xl rounded-md border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900"
            />
            <figcaption className="text-xs text-neutral-500">With your logo, fonts and accent.</figcaption>
          </figure>
        ) : null}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="text-sm font-semibold">Per channel</h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Leave a channel on the default, or give it a style of its own.</p>
        </div>
        <div className="grid max-w-xl grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
          {IMAGE_STYLE_CHANNELS.map((key) => {
            const choices = IMAGE_STYLES.filter((s) => s.built && (s.engine === "model" || TEMPLATE_CHANNELS.has(key)));
            return (
              <label key={key} className="contents">
                <span className="text-sm text-neutral-700 dark:text-neutral-300">{CHANNEL_LABELS[key]}</span>
                <select
                  value={draft.channels[key] ?? ""}
                  onChange={(e) => setChannel(key, e.target.value)}
                  disabled={disabled}
                  className="h-9 rounded-md border border-neutral-200 bg-white px-2 text-sm dark:border-neutral-800 dark:bg-neutral-950"
                >
                  <option value="">Default ({defaultLabel})</option>
                  {choices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">Fine-tune</h2>
        <div className="space-y-2">
          <div className="text-sm text-neutral-700 dark:text-neutral-300">Accent colour</div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Accent colour">
            <button
              type="button"
              aria-pressed={draft.accentHex === null}
              disabled={disabled}
              onClick={() => setDraft((d) => ({ ...d, accentHex: null }))}
              className={`rounded-full border px-3 py-1.5 text-xs ${draft.accentHex === null ? "border-blue-600 text-blue-700" : "border-neutral-200 dark:border-neutral-800"}`}
            >
              Your first brand colour
            </button>
            {palette.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={`Accent ${hex}`}
                aria-pressed={draft.accentHex === hex}
                disabled={disabled}
                onClick={() => setDraft((d) => ({ ...d, accentHex: hex }))}
                className={`h-8 w-8 rounded-full border ${draft.accentHex === hex ? "ring-2 ring-blue-600 ring-offset-2 dark:ring-offset-neutral-950" : "border-black/10"}`}
                style={{ background: hex }}
              />
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.logoOnSocial}
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, logoOnSocial: e.target.checked }))}
          />
          Your logo on social images
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.headlineOnSocial}
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, headlineOnSocial: e.target.checked }))}
          />
          The post&apos;s headline on social images, in your brand font
        </label>
      </section>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {status ? <p className="text-sm text-neutral-600 dark:text-neutral-300">{status}</p> : null}
      {canEdit ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy !== null || !check.success}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          {saved ? (
            <button
              type="button"
              onClick={reset}
              disabled={busy !== null}
              className="rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium dark:border-neutral-800"
            >
              Reset
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">Only an admin can change the image style.</p>
      )}
    </div>
  );
}
