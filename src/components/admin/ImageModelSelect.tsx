"use client";

import { IMAGE_MODEL_CHOICES, type ImageModelSlug } from "@/lib/content/create/imageModels";

/**
 * Shared image-model picker used by every image-creation surface (social post nodes, the eBook
 * studio, email-layout blocks, Brand Kit Customise). The operator picks a stable SLUG; the server
 * resolves it to the actual model id (resolveImageModel) — see imageModels.ts. Styling is passed
 * in via `className` so each surface can match its surrounding controls (chips / labelled selects).
 */
export function ImageModelSelect({
  value,
  onChange,
  disabled,
  id,
  className,
}: {
  value: ImageModelSlug;
  onChange: (value: ImageModelSlug) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ImageModelSlug)}
      title={IMAGE_MODEL_CHOICES.find((c) => c.slug === value)?.hint}
      className={
        className ??
        "rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      }
    >
      {IMAGE_MODEL_CHOICES.map((c) => (
        <option key={c.slug} value={c.slug} title={c.hint}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
