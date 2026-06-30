import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { getDb } from "./firestore";

/**
 * Resolve a git clone token for a private repo. Prefers the tenant's OAuth
 * connection (encrypted on the control-plane tenant doc), decrypted with
 * GIT_TOKEN_ENC_KEY; falls back to a static job secret (GIT_TOKEN_GITHUB/GITLAB).
 *
 * The decrypt MUST stay in sync with src/lib/integrations/crypto.ts (the worker
 * is an isolated package and can't import @/lib).
 */

function subKey(purpose: string): Buffer | null {
  const k = process.env.GIT_TOKEN_ENC_KEY;
  if (!k) return null;
  const root = createHash("sha256").update(k).digest();
  return createHmac("sha256", root).update(purpose).digest();
}

function decryptToken(blob: { ct: string; iv: string; tag: string }): string | null {
  const key = subKey("token-enc-v1");
  if (!key) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
    d.setAuthTag(Buffer.from(blob.tag, "base64"));
    return Buffer.concat([
      d.update(Buffer.from(blob.ct, "base64")),
      d.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export async function fetchGitToken(
  tenantId: string,
  provider: "github" | "gitlab",
): Promise<string | undefined> {
  // 1. Per-tenant OAuth connection (encrypted) on the control-plane tenant doc.
  try {
    const snap = await getDb("(default)").collection("tenants").doc(tenantId).get();
    const conns = (snap.data()?.gitConnections ?? {}) as Record<
      string,
      { enc?: { ct: string; iv: string; tag: string } } | undefined
    >;
    const enc = conns[provider]?.enc;
    if (enc) {
      const tok = decryptToken(enc);
      if (tok) return tok;
      // A connection exists but decrypt failed — almost always GIT_TOKEN_ENC_KEY
      // missing/rotated on THIS Job (it's a separate deploy unit from the app).
      // Log it (never the token) so the failure isn't silently masked as the
      // legacy-fallback path below.
      console.warn(
        `[gitToken] tenant=${tenantId} has a ${provider} connection but the token ` +
          `could not be decrypted — verify GIT_TOKEN_ENC_KEY is set on this Job ` +
          `and matches the app. Falling back to static secret (likely unset).`,
      );
    }
  } catch {
    /* fall through to static secret */
  }
  // 2. Legacy fallback: a static job-level secret.
  if (provider === "github") return process.env.GIT_TOKEN_GITHUB || undefined;
  if (provider === "gitlab") return process.env.GIT_TOKEN_GITLAB || undefined;
  return undefined;
}
