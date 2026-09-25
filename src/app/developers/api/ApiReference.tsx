"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

interface ScalarGlobal {
  createApiReference: (mount: HTMLElement, config: Record<string, unknown>) => { destroy: () => void };
}

/**
 * Renders an OpenAPI document with Scalar (loaded from jsDelivr, pinned and
 * integrity-checked). Read-only: no "try it" client — the API is server to
 * server, and a secret never belongs in a browser. No telemetry, AI agent or
 * third-party fonts.
 */
export function ApiReference({ specUrl, src, integrity }: { specUrl: string; src: string; integrity: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const scalar = (window as unknown as { Scalar?: ScalarGlobal }).Scalar;
    if (!ready || !mount.current || !scalar) return;
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const reference = scalar.createApiReference(mount.current, {
      url: specUrl,
      layout: "classic",
      forceDarkModeState: dark ? "dark" : "light",
      hideDarkModeToggle: true,
      hideTestRequestButton: true,
      hideClientButton: true,
      documentDownloadType: "json",
      // Fields in the contract's reading order (email, names, …), not alphabetical.
      orderSchemaPropertiesBy: "preserve",
      showDeveloperTools: "never",
      withDefaultFonts: false,
      telemetry: false,
      agent: { disabled: true },
      mcp: { disabled: true },
    });
    return () => reference.destroy();
  }, [ready, specUrl]);

  return (
    <>
      <Script
        src={src}
        integrity={integrity}
        crossOrigin="anonymous"
        strategy="afterInteractive"
        onReady={() => setReady(true)}
        onError={() => setFailed(true)}
      />
      {failed ? (
        <p className="mt-6 text-sm text-neutral-600 dark:text-neutral-400">
          The viewer didn&apos;t load. The spec itself is at{" "}
          <a className="underline" href={specUrl}>
            {specUrl}
          </a>
          .
        </p>
      ) : null}
      <div ref={mount} className="mt-6" />
    </>
  );
}
