import { createDecipheriv, createHash, createHmac, createSign } from "node:crypto";
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

/**
 * GitHub App (read-only) connections store only an installation id. Mint a
 * one-hour installation token, down-scoped to contents:read, signed with the
 * app's private key (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY on this Job).
 * Mirrors src/lib/integrations/githubApp.ts — the worker can't import @/lib.
 */
export async function mintGitHubAppToken(
  installationId: number,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const appId = env.GITHUB_APP_ID?.trim();
  const key = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!appId || !key) {
    console.warn("[gitToken] GitHub App connection but GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY aren't set on this Job.");
    return undefined;
  }
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const jwt = `${head}.${body}.${b64(createSign("RSA-SHA256").update(`${head}.${body}`).sign(key))}`;
  const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "YouGrow-Connect",
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ permissions: { contents: "read", metadata: "read" } }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string };
  if (!res.ok || !data.token) {
    console.warn(`[gitToken] GitHub App token request failed (${res.status}).`);
    return undefined;
  }
  return data.token;
}

/**
 * Normalized repo path (lowercased, no `.git`), or null. MUST match
 * repoPathFromUrl in src/lib/integrations/repos.ts.
 */
export function repoPathFromUrl(provider: "github" | "gitlab", raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== (provider === "github" ? "github.com" : "gitlab.com")) return null;
  let path = u.pathname.split("/-/")[0] ?? "";
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase();
  const parts = path.split("/").filter(Boolean);
  if (provider === "github" ? parts.length !== 2 : parts.length < 2) return null;
  return parts.join("/");
}

/**
 * Whether the connection's token may be used for this repo. `repos` undefined =
 * legacy connection (any repo); otherwise only the repos the admin selected.
 */
export function isRepoSelected(
  provider: "github" | "gitlab",
  repos: { fullPath?: string }[] | undefined,
  sourceUri: string,
): boolean {
  if (!Array.isArray(repos)) return true;
  const path = repoPathFromUrl(provider, sourceUri);
  return path !== null && repos.some((r) => r.fullPath === path);
}

export async function fetchGitToken(
  tenantId: string,
  provider: "github" | "gitlab",
  sourceUri: string,
): Promise<string | undefined> {
  // 1. Per-tenant OAuth connection (encrypted) on the control-plane tenant doc.
  try {
    const snap = await getDb("(default)").collection("tenants").doc(tenantId).get();
    const conns = (snap.data()?.gitConnections ?? {}) as Record<
      string,
      | {
          kind?: string;
          installationId?: number;
          enc?: { ct: string; iv: string; tag: string };
          repos?: { fullPath?: string }[];
        }
      | undefined
    >;
    const conn = conns[provider];
    if (conn && (conn.enc || conn.kind === "app") && !isRepoSelected(provider, conn.repos, sourceUri)) {
      // The admin didn't select this repo on the connection: clone without a
      // token (public repos still work) and never fall back to the static secret.
      console.warn(
        `[gitToken] tenant=${tenantId} ${provider} repo not selected on the connection — cloning unauthenticated.`,
      );
      return undefined;
    }
    // Read-only GitHub App: mint a one-hour installation token (it can only
    // reach the repos the customer installed the app on).
    if (provider === "github" && conn?.kind === "app" && typeof conn.installationId === "number") {
      return await mintGitHubAppToken(conn.installationId);
    }
    const enc = conn?.enc;
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
