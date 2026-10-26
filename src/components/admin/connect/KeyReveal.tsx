"use client";

import type { ReactNode } from "react";
import { Banner, CopyField } from "./ui";

/**
 * The credentials. The secret is only ever returned by the create and rotate calls,
 * so this is the one moment it can be copied. A launch's site key passes its own
 * note and labels; a product connection keeps the defaults.
 */
export function KeyReveal({
  keyId,
  secret,
  note,
  keyLabel = "Key id — the username for HTTP Basic auth",
  secretLabel = "Secret — the password; keep it server-side",
}: {
  keyId: string;
  secret: string;
  note?: ReactNode;
  keyLabel?: string;
  secretLabel?: string;
}) {
  return (
    <div className="space-y-3">
      <Banner tone="info">
        {note ?? (
          <>
            Copy the secret now and store it in your product&apos;s secret manager. It is shown only
            once — if you lose it, rotate it from Settings.
          </>
        )}
      </Banner>
      <CopyField label={keyLabel} value={keyId} />
      <CopyField label={secretLabel} value={secret} />
    </div>
  );
}
