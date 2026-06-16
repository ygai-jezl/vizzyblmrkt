"use client";

import { useState } from "react";

/**
 * The tenant brand mark shown at the top of the admin sidebar. Renders the
 * brand favicon (a plain <img>, NOT next/image — avoids configuring remote
 * image hosts), and falls back to a neutral monogram (first letter of the brand
 * name) when no favicon is set or the image fails to load. Image-load failure
 * can only be caught client-side, which is why this is a client component.
 */
export function BrandFavicon({
  name,
  faviconUrl,
  size = 20,
}: {
  name: string;
  faviconUrl?: string;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);

  if (!faviconUrl || errored) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size }}
        className="grid shrink-0 place-items-center rounded bg-neutral-200 text-xs font-semibold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
      >
        {(name?.trim()?.[0] ?? "?").toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={faviconUrl}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded"
      onError={() => setErrored(true)}
    />
  );
}
