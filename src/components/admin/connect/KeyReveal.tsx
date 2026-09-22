"use client";

import { Banner, CopyField } from "./ui";

/**
 * The connection's credentials. The secret is only ever returned by the create
 * and rotate calls, so this is the one moment it can be copied.
 */
export function KeyReveal({ keyId, secret }: { keyId: string; secret: string }) {
  return (
    <div className="space-y-3">
      <Banner tone="info">
        Copy the secret now and store it in your product&apos;s secret manager. It is shown only
        once — if you lose it, rotate it from Settings.
      </Banner>
      <CopyField label="Key id (X-YouGrow-Key-Id)" value={keyId} />
      <CopyField label="Secret (signs the events you send — keep it server-side)" value={secret} />
    </div>
  );
}
