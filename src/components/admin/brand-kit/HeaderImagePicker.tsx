"use client";

import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { emailHeaderImagePublicUrl } from "@/lib/content/brandKit";
import { isEmailHeaderImage } from "@/lib/email/emailStyle";
import { EMAIL_HEADER_IMAGE_LIMITS } from "@/lib/types/tenant";
import {
  allOpaque,
  bannerAttempts,
  bannerFileName,
  bannerSize,
  BANNER_TYPE_MESSAGE,
  climbBannerLadder,
  isBannerType,
  type BannerStep,
  type EmailHeaderImageChoice,
} from "./headerImage";

/**
 * Brand › Email style's header images (Image mode, with the header options on): the banners
 * uploaded here, each on the header colour, to pick one for the header. Admins can upload a
 * banner — shrunk and encoded here on a canvas (headerImage.ts has the ladder) until it's a PNG
 * or JPG of at most 1 MB and 1200px wide — and delete one; members only see them. Picking or
 * uploading only changes the form: emails change when the style is saved.
 */

const HINT = "text-xs text-neutral-500";
const BTN =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700";
const ERROR = "text-xs text-red-600 dark:text-red-400";

const CANT_READ = "We couldn't read this image — save it again as a PNG or JPG";

const DELETE_IN_USE =
  "Delete this header image? Your emails go back to the header colour. Emails already sent may stop showing it.";
const DELETE_UNUSED = "Delete this header image? Emails already sent with it may stop showing it.";

/** A message as a sentence: the server's and the ladder's don't all end in a full stop. */
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Load an image (an object URL) for drawing; null if it won't load or has no size. */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** The image drawn at ≤ `maxWidth` (and 2400 tall), smoothed; null when there's no canvas. */
function draw(img: HTMLImageElement, maxWidth: number): HTMLCanvasElement | null {
  const size = bannerSize(img.naturalWidth, img.naturalHeight, maxWidth);
  if (!size) return null;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, size.width, size.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, mime, quality);
    } catch {
      resolve(null); // a tainted or unsupported canvas: a message, never an error
    }
  });
}

/**
 * A picked file, ready to upload: at most 1200px wide and 1 MB, PNG or JPG (a JPG is always
 * redrawn, so it arrives upright and without its metadata), or why it can't be.
 */
async function prepareBanner(file: File): Promise<{ file: File } | { message: string }> {
  const type = file.type;
  if (!isBannerType(type)) return { message: BANNER_TYPE_MESSAGE };
  const src = URL.createObjectURL(file);
  try {
    const img = await loadImage(src);
    if (!img) return { message: CANT_READ };
    // One canvas per width, shared by the steps (and the transparency check) that use it.
    const canvases = new Map<number, HTMLCanvasElement | null>();
    const at = (maxWidth: number) => {
      if (!canvases.has(maxWidth)) canvases.set(maxWidth, draw(img, maxWidth));
      return canvases.get(maxWidth) ?? null;
    };
    let opaque = true;
    if (type === "image/png") {
      // Read at the full width, which the ladder's first redraw reuses.
      const canvas = at(EMAIL_HEADER_IMAGE_LIMITS.width);
      const g = canvas?.getContext("2d");
      if (!canvas || !g) return { message: CANT_READ };
      opaque = allOpaque(g.getImageData(0, 0, canvas.width, canvas.height).data);
    }
    const plan = bannerAttempts({ type, opaque, width: img.naturalWidth, height: img.naturalHeight });
    const encode = async (step: BannerStep): Promise<Blob | null> => {
      if (step === "original") return file;
      const canvas = at(step.maxWidth);
      return canvas ? toBlob(canvas, step.mime, step.quality) : null;
    };
    const picked = await climbBannerLadder(plan.steps, encode);
    if (picked === "unreadable") return { message: CANT_READ };
    if (picked === "too_big") return { message: plan.refusal };
    const { step, result } = picked;
    const outType = step === "original" ? type : isBannerType(result.type) ? result.type : step.mime;
    return { file: new File([result], bannerFileName(file.name, outType), { type: outType }) };
  } catch {
    return { message: CANT_READ }; // a tainted or failed canvas: a message, never an exception
  } finally {
    URL.revokeObjectURL(src);
  }
}

export function HeaderImagePicker({
  images,
  selectedId,
  inUseId,
  tenantId,
  headerColor,
  canEdit,
  disabled,
  onSelect,
  onUploaded,
  onDeleted,
  onBusy,
}: {
  /** The usable header images, newest first. */
  images: readonly EmailHeaderImageChoice[];
  /** The one picked in the form. */
  selectedId: string | null;
  /** The one the saved style uses ("In use"). */
  inUseId: string | null;
  tenantId: string;
  /** The thumbnails sit on it, as the banner does in the email. */
  headerColor: string;
  canEdit: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onUploaded: (image: EmailHeaderImageChoice) => void;
  /** Deleted: `cleared` = the saved style used it, and is back to the header colour. */
  onDeleted: (id: string, cleared: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [working, setWorking] = useState<null | "prepare" | "upload" | "delete">(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const off = disabled || working !== null;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file after a failure
    if (!picked) return;
    setError(null);
    if (!isBannerType(picked.type)) {
      setError(sentence(BANNER_TYPE_MESSAGE));
      return;
    }
    setWorking("prepare");
    onBusy(true);
    try {
      const ready = await prepareBanner(picked);
      if ("message" in ready) {
        setError(sentence(ready.message));
        return;
      }
      setWorking("upload");
      const fd = new FormData();
      fd.append("file", ready.file);
      const res = await fetch("/api/admin/brand-kit/email-style/header-images", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { image?: EmailHeaderImageChoice; message?: string };
      if (!res.ok || !data.image || !isEmailHeaderImage({ ...data.image, category: "header" })) {
        setError(
          sentence(
            data.message ??
              (res.status === 403
                ? "Only an admin can upload a header image"
                : res.status === 503
                  ? "Header images aren't switched on here, so the image can't be uploaded"
                  : "Couldn't upload the image — try again"),
          ),
        );
        return;
      }
      onUploaded(data.image);
    } catch {
      setError("Couldn't upload the image — check your connection and try again.");
    } finally {
      setWorking(null);
      onBusy(false);
    }
  }

  async function remove(image: EmailHeaderImageChoice) {
    if (!window.confirm(image.id === inUseId ? DELETE_IN_USE : DELETE_UNUSED)) return;
    setWorking("delete");
    setDeletingId(image.id);
    onBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/brand-kit/email-style/header-images/${encodeURIComponent(image.id)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { cleared?: boolean };
      if (res.status === 404) {
        // Already gone (deleted elsewhere): drop it from the list. That Delete took it off the
        // saved style first, so the one in use is cleared here too.
        onDeleted(image.id, image.id === inUseId);
        return;
      }
      if (!res.ok) {
        setError(
          res.status === 403
            ? "Only an admin can delete a header image."
            : res.status === 503
              ? "Header images aren't switched on here."
              : "Couldn't delete the image — try again.",
        );
        return;
      }
      onDeleted(image.id, data.cleared === true);
    } catch {
      setError("Couldn't delete the image — check your connection and try again.");
    } finally {
      setWorking(null);
      setDeletingId(null);
      onBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={HINT}>
          A PNG or JPG banner, full width at the top of each email. 1200px wide is best; bigger images are shrunk
          before upload.
        </p>
        {canEdit ? (
          <>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => void onPick(e)}
              className="hidden"
            />
            <button
              type="button"
              disabled={off}
              onClick={() => inputRef.current?.click()}
              className={`flex shrink-0 items-center gap-1.5 font-medium ${BTN}`}
            >
              <ImagePlus size={15} />
              {working === "prepare" ? "Preparing…" : working === "upload" ? "Uploading…" : "Upload a banner"}
            </button>
          </>
        ) : null}
      </div>
      {images.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {images.map((image) => {
            const checked = image.id === selectedId;
            return (
              <div
                key={image.id}
                className={`space-y-2 rounded-md border p-2 text-sm ${
                  checked ? "border-neutral-900 dark:border-neutral-100" : "border-neutral-200 dark:border-neutral-800"
                }`}
              >
                <label className={`block space-y-2 ${off ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
                  <span
                    className="grid h-20 place-items-center overflow-hidden rounded"
                    style={{ backgroundColor: headerColor }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={emailHeaderImagePublicUrl(tenantId, image.filename)}
                      alt=""
                      className="max-h-20 max-w-full object-contain"
                    />
                  </span>
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="email-style-header-image"
                      checked={checked}
                      disabled={off}
                      onChange={() => onSelect(image.id)}
                    />
                    <span className="min-w-0 flex-1 truncate" title={image.title}>
                      {image.title}
                    </span>
                    {image.id === inUseId ? (
                      <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        In use
                      </span>
                    ) : null}
                  </span>
                </label>
                <span className="flex items-center justify-between gap-2">
                  <span className={HINT}>
                    {image.width} × {image.height}
                  </span>
                  {canEdit ? (
                    <button
                      type="button"
                      disabled={off}
                      onClick={() => void remove(image)}
                      aria-label={`Delete ${image.title}`}
                      className="text-xs text-red-600 underline-offset-2 hover:underline disabled:opacity-50 dark:text-red-400"
                    >
                      {deletingId === image.id ? "Deleting…" : "Delete"}
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className={HINT}>{canEdit ? "No header images yet — upload a banner." : "No header images yet."}</p>
      )}
      {error ? (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
