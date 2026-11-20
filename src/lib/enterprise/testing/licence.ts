import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { licenceSigningInput, okpThumbprint, type LicenceClaims, type LicenceHeader } from "../licence";
import type { LicencePublicJwk } from "../publicKeys";

/**
 * Licence keys for tests only. Each run makes a fresh Ed25519 key pair, so no private key is
 * ever committed. Real keys are issued from the private deploy repo or offline, never here.
 */

/** Raw parts that replace the minted ones, to build broken or tampered keys. */
export interface RawLicenceParts {
  prefix?: string;
  header?: string;
  payload?: string;
  signature?: string;
}

export interface TestLicenceKeyPair {
  publicJwk: LicencePublicJwk;
  privateKey: KeyObject;
  /**
   * A key string signed with this pair. The header defaults to { alg: "EdDSA", typ: "ygel1",
   * kid } and headerOverrides change it; claims go in as given, so a test can sign bad ones.
   * A raw header or payload is signed as given unless a raw signature is passed too.
   */
  mint(claims: object, headerOverrides?: Record<string, unknown>, rawParts?: RawLicenceParts): string;
}

export function makeLicenceKeyPair(): TestLicenceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  if (!x) throw new Error("no_public_x");
  const base = { kty: "OKP" as const, crv: "Ed25519" as const, x };
  const publicJwk: LicencePublicJwk = { ...base, kid: okpThumbprint(base) };

  const mint: TestLicenceKeyPair["mint"] = (claims, headerOverrides = {}, rawParts = {}) => {
    const header = { alg: "EdDSA", typ: "ygel1", kid: publicJwk.kid, ...headerOverrides };
    const minted = licenceSigningInput(header as unknown as LicenceHeader, claims as LicenceClaims);
    const [h, p] = minted.slice("ygel_".length).split(".") as [string, string];
    const signedText = `ygel_${rawParts.header ?? h}.${rawParts.payload ?? p}`;
    const s = rawParts.signature ?? sign(null, Buffer.from(signedText, "ascii"), privateKey).toString("base64url");
    return `${rawParts.prefix ?? "ygel_"}${rawParts.header ?? h}.${rawParts.payload ?? p}.${s}`;
  };

  return { publicJwk, privateKey, mint };
}

/** Claims that verify at nowMs: issued an hour before, ending a year after. */
export function goodClaims(nowMs: number, overrides: Record<string, unknown> = {}): LicenceClaims {
  const now = Math.floor(nowMs / 1000);
  return {
    v: 1,
    lid: "lic_test_1",
    licensee: "Example Ltd",
    seats: 25,
    features: ["sso", "audit_export"],
    iat: now - 3600,
    exp: now + 365 * 24 * 3600,
    ...overrides,
  } as LicenceClaims;
}
