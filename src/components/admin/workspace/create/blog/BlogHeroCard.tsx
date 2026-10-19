"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ThumbsDown, ThumbsUp, UploadCloud, RefreshCw, ImageIcon } from "lucide-react";
import type { ContentNode } from "@/lib/types/contentPlan";
import { heroTitle } from "@/lib/content/blog/heroTitle";
import { imageStyleById } from "@/lib/content/imageStyle/catalogue";
import { ImageStylePicker } from "@/components/admin/imageStyle/ImageStylePicker";
import { BRAND_KIT_SCREENSHOTS_ROUTE } from "@/lib/content/brandKit";
import type { BlogHeroControls } from "./types";

/** How long a run holds the hero (the server's lease); a pending one older than this died. */
const LEASE_MS = 150_000;

const BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900";

function styleName(id: string | null): string {
  if (id === "title_card") return "Title card";
  if (id === "upload") return "Your image";
  return (id && imageStyleById(id)?.label) || "Brand style";
}

/**
 * The blog article's hero image and share card (BLOG_HERO_ENABLED): made after the fact check,
 * shown here with its style ("This article only" changes it for this article), Make again,
 * Upload your own, the alt text and thumbs for the style's learning.
 */
export function BlogHeroCard({ node, controls, disabled }: { node: ContentNode; controls: BlogHeroControls; disabled?: boolean }) {
  const hero = node.blog?.hero ?? null;
  const [alt, setAlt] = useState(hero?.alt ?? "");
  const [error, setError] = useState<string | null>(null);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setAlt(hero?.alt ?? ""), [hero?.alt, hero?.heroRef]);
  useEffect(() => setVote(null), [hero?.assetId]);

  const making =
    controls.busyId === node.id ||
    (hero?.status === "pending" && !!hero.startedAt && Date.now() - Date.parse(hero.startedAt) < LEASE_MS);
  const off = disabled || making;
  const has = Boolean(hero?.heroRef && hero?.shareRef);
  const titleChanged = has && hero!.forTitle && hero!.forTitle !== heroTitle(node);

  async function run(p: Promise<string | null>) {
    setError(null);
    setError(await p);
  }

  async function sendVote(next: "up" | "down") {
    if (!hero?.assetId) return;
    const v = vote === next ? null : next;
    setVote(v);
    await fetch(`/api/admin/brand-kit/images/${hero.assetId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vote: v }),
    }).catch(() => null);
  }

  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">Hero image</div>
        <div className="w-48">
          <ImageStylePicker
            surface="blogHero"
            value={hero?.styleOverride ?? null}
            onChange={(id) => void run(controls.make(node.id, id ?? "brand"))}
            disabled={off}
            selectClassName="w-full rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          />
        </div>
      </div>

      {has ? (
        <div className={`flex flex-wrap items-end gap-3 ${making ? "opacity-50" : ""}`}>
          <figure className="w-64 max-w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={controls.assetUrl(hero!.heroRef!)} alt={hero!.alt} className="aspect-video w-full rounded border border-neutral-200 object-cover dark:border-neutral-800" />
            <figcaption className="mt-1 text-[11px] text-neutral-500">Hero, 1600 x 900</figcaption>
          </figure>
          <figure className="w-40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={controls.assetUrl(hero!.shareRef!)} alt="" className="aspect-[1200/630] w-full rounded border border-neutral-200 object-cover dark:border-neutral-800" />
            <figcaption className="mt-1 text-[11px] text-neutral-500">Share card, 1200 x 630</figcaption>
          </figure>
        </div>
      ) : (
        <div className="flex aspect-video w-64 max-w-full items-center justify-center rounded border border-dashed border-neutral-300 text-neutral-400 dark:border-neutral-700">
          <ImageIcon size={20} />
        </div>
      )}

      <p role="status" className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        {making
          ? "Making the hero image…"
          : !has
            ? "No hero image yet."
            : `${styleName(hero!.styleId)}${hero!.styleOverride ? ", this article only" : ""}.`}
      </p>
      {!making && hero?.status === "fallback" ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">A title card for now: the image model didn&apos;t answer. Try the image again.</p>
      ) : null}
      {!making && hero?.status === "failed" ? (
        <p className="mt-1 text-xs text-red-600">The last try wasn&apos;t saved{has ? ", so the earlier image stays" : ""}.</p>
      ) : null}
      {!making && hero?.note === "no_screenshot" ? (
        <p className="mt-1 text-xs text-neutral-500">
          Drawn without a product screen. <Link href={BRAND_KIT_SCREENSHOTS_ROUTE} className="underline">Add screenshots</Link>.
        </p>
      ) : null}
      {!making && hero?.note === "bundled_font" ? (
        <p className="mt-1 text-xs text-neutral-500">
          Drawn in a standard font. <Link href="/admin/brand-kit/fonts" className="underline">Add your fonts</Link>.
        </p>
      ) : null}
      {!making && titleChanged ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">The title changed since this was made.</p> : null}
      {has && node.blog?.live?.shareImage === false ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          Your live page has no share image, so links to it show none. Copy the share tags under Export into its head.
        </p>
      ) : null}

      {has ? (
        <label className="mt-2 block text-xs">
          <span className="text-neutral-500">Alt text</span>
          <input
            value={alt}
            maxLength={250}
            disabled={off}
            onChange={(e) => setAlt(e.target.value)}
            onBlur={() => {
              if (alt.trim() !== (hero?.alt ?? "")) void run(controls.setAlt(node.id, alt));
            }}
            className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON} disabled={off} onClick={() => void run(controls.make(node.id))}>
          <RefreshCw size={12} />
          {!has ? "Make hero image" : hero?.status === "fallback" ? "Try the image again" : "Make again"}
        </button>
        <button type="button" className={BUTTON} disabled={off} onClick={() => fileRef.current?.click()}>
          <UploadCloud size={12} /> Upload your own
        </button>
        {hero?.assetId && hero.status === "ready" ? (
          <span className="ml-auto flex items-center gap-1">
            <button type="button" aria-label="On brand" aria-pressed={vote === "up"} onClick={() => void sendVote("up")} className={`rounded p-1 ${vote === "up" ? "text-emerald-600" : "text-neutral-400 hover:text-neutral-700"}`}>
              <ThumbsUp size={14} />
            </button>
            <button type="button" aria-label="Off brand" aria-pressed={vote === "down"} onClick={() => void sendVote("down")} className={`rounded p-1 ${vote === "down" ? "text-red-600" : "text-neutral-400 hover:text-neutral-700"}`}>
              <ThumbsDown size={14} />
            </button>
          </span>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void run(controls.upload(node.id, file));
        }}
      />
    </div>
  );
}
