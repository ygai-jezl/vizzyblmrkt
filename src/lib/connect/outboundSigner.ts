import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import {
  crc32c,
  derToJose,
  outboundClaims,
  pemToPublicJwk,
  signingInput,
  b64url,
  type OutboundDirection,
  type PublicJwk,
} from "./outboundToken";
import { HEADER_KEY_ID } from "./protocol";

/**
 * Signs the platform's requests to products (context pulls, webhooks) — see
 * outboundToken.ts for the token. The private key is a Cloud KMS key
 * (EC_SIGN_P256_SHA256, HSM) that never leaves KMS; the runtime service account
 * may only sign with it and read its public keys (infra/lifecycle/setup.sh
 * signing-key).
 *
 * Rotation (KMS doesn't rotate asymmetric keys automatically): add a key version
 * (`setup.sh rotate-signing-key`). Every ENABLED version is published in the
 * JWKS at once, but a version signs only after it has been published for
 * PUBLISH_BEFORE_USE_MS — so verifiers that cached the old key set pick up the
 * new key before they ever meet it. Disable the old version once the new one
 * is signing; it drops out of the JWKS.
 *
 * Outside production (local dev, tests) with no KMS key configured, an
 * EPHEMERAL in-memory key signs instead — generated per process, never stored,
 * and never available where NODE_ENV is production (dev and prod App Hosting
 * both run production builds, so both must use KMS).
 */

export const KMS_KEY_ENV = "CONNECT_SIGNING_KMS_KEY";
export const ISSUER_ENV = "CONNECT_ISSUER";

/** A new key version is published this long before it signs anything. */
export const PUBLISH_BEFORE_USE_MS = 24 * 3600_000;
const VERSION_LIST_TTL_MS = 5 * 60_000;
const KMS_TIMEOUT_MS = 5000;

export class OutboundSigningUnavailable extends Error {
  constructor(reason: string) {
    super(`outbound_signing_unavailable:${reason}`);
    this.name = "OutboundSigningUnavailable";
  }
}

export interface ActiveSigner {
  kid: string;
  /** Sign `data`; returns the 64-byte JOSE (r‖s) ES256 signature. */
  sign(data: Buffer): Promise<Buffer>;
}

export interface SigningKeySource {
  /** Every key verifiers should accept right now (the published JWKS). */
  publicKeys(): Promise<PublicJwk[]>;
  /** The key to sign with now. */
  signer(nowMs: number): Promise<ActiveSigner>;
}

// ---- Cloud KMS -------------------------------------------------------------------

interface KmsVersion {
  name: string;
  createTimeMs: number;
  jwk: PublicJwk;
}

type KmsRequest = <T>(opts: { url: string; method?: "GET" | "POST"; data?: unknown }) => Promise<T>;

function googleRequest(): KmsRequest {
  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  return async <T>(opts: { url: string; method?: "GET" | "POST"; data?: unknown }) => {
    const client = await auth.getClient();
    const res = await client.request<T>({ ...opts, timeout: KMS_TIMEOUT_MS, retry: false });
    return res.data;
  };
}

const KMS_API = "https://cloudkms.googleapis.com/v1";

export function kmsKeySource(keyName: string, request: KmsRequest = googleRequest()): SigningKeySource {
  const publicKeyCache = new Map<string, PublicJwk>();
  let listed: { at: number; versions: KmsVersion[] } | null = null;

  async function publicKeyOf(name: string): Promise<PublicJwk> {
    const hit = publicKeyCache.get(name);
    if (hit) return hit;
    const r = await request<{ pem: string; algorithm: string; pemCrc32c?: string; name?: string }>({
      url: `${KMS_API}/${name}/publicKey`,
    });
    // Google's integrity guidance: the response is for the version asked for,
    // uncorrupted in transit.
    if (r.name && r.name !== name) throw new OutboundSigningUnavailable("kms_public_key_name");
    if (r.pemCrc32c && crc32c(Buffer.from(r.pem, "utf8")) !== Number(r.pemCrc32c)) {
      throw new OutboundSigningUnavailable("kms_public_key_crc");
    }
    if (r.algorithm !== "EC_SIGN_P256_SHA256") throw new OutboundSigningUnavailable("kms_wrong_algorithm");
    const jwk = pemToPublicJwk(r.pem);
    publicKeyCache.set(name, jwk); // a version's public key never changes
    return jwk;
  }

  async function versions(): Promise<KmsVersion[]> {
    if (listed && Date.now() - listed.at < VERSION_LIST_TTL_MS) return listed.versions;
    const r = await request<{ cryptoKeyVersions?: { name: string; state: string; algorithm: string; createTime: string }[] }>({
      url: `${KMS_API}/${keyName}/cryptoKeyVersions?filter=${encodeURIComponent("state=ENABLED")}&pageSize=50`,
    });
    const enabled = (r.cryptoKeyVersions ?? []).filter(
      (v) => v.state === "ENABLED" && v.algorithm === "EC_SIGN_P256_SHA256",
    );
    const out = await Promise.all(
      enabled.map(async (v) => ({ name: v.name, createTimeMs: Date.parse(v.createTime), jwk: await publicKeyOf(v.name) })),
    );
    out.sort((a, b) => b.createTimeMs - a.createTimeMs);
    listed = { at: Date.now(), versions: out };
    return out;
  }

  return {
    async publicKeys() {
      return (await versions()).map((v) => v.jwk);
    },
    async signer(nowMs) {
      const all = await versions();
      if (!all.length) throw new OutboundSigningUnavailable("no_enabled_key_version");
      // Newest version that's been published long enough; while only brand-new
      // versions exist (first setup), the longest-published one.
      const v = all.find((x) => nowMs - x.createTimeMs >= PUBLISH_BEFORE_USE_MS) ?? all[all.length - 1]!;
      return {
        kid: v.jwk.kid,
        async sign(data) {
          const digest = createHash("sha256").update(data).digest();
          const r = await request<{ signature: string; signatureCrc32c: string; verifiedDigestCrc32c?: boolean; name: string }>({
            url: `${KMS_API}/${v.name}:asymmetricSign`,
            method: "POST",
            data: { digest: { sha256: digest.toString("base64") }, digestCrc32c: String(crc32c(digest)) },
          });
          const der = Buffer.from(r.signature, "base64");
          if (r.name !== v.name || !r.verifiedDigestCrc32c || crc32c(der) !== Number(r.signatureCrc32c)) {
            throw new OutboundSigningUnavailable("kms_integrity");
          }
          return derToJose(der);
        },
      };
    },
  };
}

// ---- Ephemeral (local dev + tests only) -----------------------------------------

export function ephemeralKeySource(privateKey?: KeyObject): SigningKeySource {
  const key = privateKey ?? generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const jwk = pemToPublicJwk(createPublicKey(key).export({ format: "pem", type: "spki" }).toString());
  return {
    async publicKeys() {
      return [jwk];
    },
    async signer() {
      return {
        kid: jwk.kid,
        async sign(data) {
          return cryptoSign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
        },
      };
    },
  };
}

// ---- Configuration -----------------------------------------------------------------

let override: SigningKeySource | null = null;
let configured: { key: string; source: SigningKeySource } | null = null;
let ephemeral: SigningKeySource | null = null;

/** Tests: sign with a given source (null restores the environment's). */
export function __setSigningKeySource(src: SigningKeySource | null): void {
  override = src;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function signingKeySource(): SigningKeySource {
  if (override) return override;
  const key = process.env[KMS_KEY_ENV]?.trim();
  if (key) {
    if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(key)) {
      throw new OutboundSigningUnavailable("bad_kms_key_name");
    }
    if (configured?.key !== key) configured = { key, source: kmsKeySource(key) };
    return configured.source;
  }
  if (isProduction()) throw new OutboundSigningUnavailable("kms_key_unconfigured");
  ephemeral ??= ephemeralKeySource();
  return ephemeral;
}

/**
 * The `iss` on every token, and where its JWKS lives (`${issuer}/.well-known/jwks.json`).
 * Production must set it explicitly (https); elsewhere it defaults to local dev.
 */
export function outboundIssuer(): string {
  const v = process.env[ISSUER_ENV]?.trim().replace(/\/+$/, "");
  if (v) {
    if (isProduction() && !v.startsWith("https://")) throw new OutboundSigningUnavailable("issuer_not_https");
    return v;
  }
  if (isProduction()) throw new OutboundSigningUnavailable("issuer_unconfigured");
  return "http://localhost:3000";
}

/** The public keys to publish (and that the in-process sandbox verifies against). */
export async function publishedJwks(): Promise<PublicJwk[]> {
  return signingKeySource().publicKeys();
}

/**
 * Headers for one platform→product request: `Authorization: Bearer <JWT>` over
 * this exact body, plus the connection's key id so a product serving several
 * connections can pick the audience. Throws OutboundSigningUnavailable.
 */
export async function signOutboundRequest(input: {
  audience: string;
  direction: OutboundDirection;
  jti: string;
  rawBody: string;
  nowMs?: number;
}): Promise<Record<string, string>> {
  const nowMs = input.nowMs ?? Date.now();
  const issuer = outboundIssuer();
  let signer: ActiveSigner;
  try {
    signer = await signingKeySource().signer(nowMs);
  } catch (err) {
    if (err instanceof OutboundSigningUnavailable) throw err;
    throw new OutboundSigningUnavailable("kms_unreachable");
  }
  const claims = outboundClaims({ issuer, audience: input.audience, direction: input.direction, jti: input.jti, rawBody: input.rawBody, nowMs });
  const data = signingInput(signer.kid, claims);
  let sig: Buffer;
  try {
    sig = await signer.sign(Buffer.from(data));
  } catch (err) {
    if (err instanceof OutboundSigningUnavailable) throw err;
    throw new OutboundSigningUnavailable("kms_sign_failed");
  }
  return {
    "content-type": "application/json",
    authorization: `Bearer ${data}.${b64url(sig)}`,
    [HEADER_KEY_ID]: input.audience,
  };
}

