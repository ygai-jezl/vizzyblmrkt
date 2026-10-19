"use client";

import { IMAGE_STYLES, builtImageStyles } from "@/lib/content/imageStyle/catalogue";
import { resolveImageStyle, usableStyle, type ImageSurface } from "@/lib/content/imageStyle/resolve";
import { useBrandImageStyle } from "./useBrandImageStyle";

export interface LegacyStyleOption {
  id: string;
  label: string;
}

/**
 * The style menu next to Generate, on every surface that makes an image. It opens on the
 * brand's default; anything else applies to this one image only and is saved with it.
 * `value` is that image's own pick (a style id or an old preset id), or null for the brand's.
 */
export function ImageStylePicker({
  surface,
  channel,
  value,
  onChange,
  legacy = [],
  disabled,
  className = "",
  selectClassName = "",
}: {
  surface: ImageSurface;
  channel?: string | null;
  value: string | null;
  onChange: (next: string | null) => void;
  legacy?: LegacyStyleOption[];
  disabled?: boolean;
  className?: string;
  selectClassName?: string;
}) {
  const { style: brand } = useBrandImageStyle();
  const brandStyle = resolveImageStyle({ enabled: true, surface, channel, brand, override: null });
  const brandLabel = brandStyle.engine === "legacy" ? "today's look" : brandStyle.label;
  const choices = builtImageStyles().filter((s) => usableStyle(s.id, surface)?.id === s.id);
  const coming = IMAGE_STYLES.filter((s) => !s.built);
  const own = value && value !== "brand" ? value : null;

  return (
    <div className={className}>
      <select
        aria-label="Image style"
        value={own ?? "brand"}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "brand" ? null : e.target.value)}
        className={selectClassName}
      >
        <option value="brand">Brand default ({brandLabel})</option>
        <optgroup label="This image only">
          {choices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </optgroup>
        {coming.length > 0 ? (
          <optgroup label="Coming soon">
            {coming.map((s) => (
              <option key={s.id} value={s.id} disabled>
                {s.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        {legacy.length > 0 ? (
          <optgroup label="Older looks">
            {legacy.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      {own ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          className="mt-1 text-[11px] text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
        >
          This image only · Reset to brand default
        </button>
      ) : null}
    </div>
  );
}
