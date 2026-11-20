import { ENTERPRISE_FEATURE_IDS, type EnterpriseFeature } from "./features";
import { currentLicence, type LicenceFailure, type LicenceResult } from "./licence";

/**
 * The one door into Enterprise code. This is the only file allowed to import from src/ee
 * (ESLint and src/lib/enterprise/boundary.test.ts enforce it), so the app builds and runs
 * without that folder.
 *
 * What it answers: may this deployment run feature X? Yes when this build has the code for X
 * and the deployment's licence key (ENTERPRISE_LICENCE_KEY) is valid and lists X. It takes no
 * brand or organisation, and its signature will not change.
 *
 * - Every deployment answers the same way. The hosted dev and prod copies will each carry their
 *   own owner-issued key, kept in the private deploy repo, once the first Enterprise feature
 *   ships. One code path runs everywhere.
 * - Whether an organisation's plan includes X ("may this organisation use X") will be a separate
 *   function in src/lib/plans. Callers ask both.
 * - src/lib/plans/brandAccess.ts stays the per-brand gate for metered features. Its "the one
 *   place a plan or tier check belongs" comment changes when the plan check arrives.
 * - Seats: the plan check counts an organisation's users. Enforcing a licence key's seats, a
 *   grace period after a key expires and a licence status screen come with the first
 *   Enterprise feature.
 * - Once src/ee holds code this file imports, a build without the folder needs a fallback
 *   alias for those imports. ADR-0007 in docs/DECISIONS.md has the plan.
 *
 * Node runtime only (it reads the licence with node:crypto): never import this from middleware
 * or a client component. Import it as "@/lib/enterprise/registry"; other folders have their own
 * registry.ts.
 */

/** The Enterprise code this build has, by feature. Empty: no Enterprise code exists yet. */
export const EE_CODE: Partial<Record<EnterpriseFeature, true>> = {};

export type FeatureReason = "licensed" | "code_absent" | "not_in_licence" | LicenceFailure;

export interface FeatureAnswer {
  feature: EnterpriseFeature;
  on: boolean;
  reason: FeatureReason;
  /** The licence read for this answer, when there is one: valid, expired, or without this feature. */
  licence?: { licensee: string; seats: number; exp: number };
}

export interface RegistryDeps {
  hasCode: (feature: EnterpriseFeature) => boolean;
  licence: () => LicenceResult;
}

const DEFAULT_DEPS: RegistryDeps = {
  hasCode: (feature) => EE_CODE[feature] === true,
  licence: () => currentLicence(),
};

function readLicence(licence: RegistryDeps["licence"]): LicenceResult {
  try {
    return licence();
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

function codePresent(hasCode: RegistryDeps["hasCode"], feature: EnterpriseFeature): boolean {
  try {
    return hasCode(feature) === true;
  } catch {
    return false;
  }
}

/**
 * Whether this deployment may run a feature, and why. Checked in this order: code_absent, the
 * licence's failure, not_in_licence, licensed. Never throws, whatever the setting holds.
 */
export function enterpriseFeature(feature: EnterpriseFeature, deps: Partial<RegistryDeps> = {}): FeatureAnswer {
  const hasCode = deps.hasCode ?? DEFAULT_DEPS.hasCode;
  const licence = deps.licence ?? DEFAULT_DEPS.licence;
  if (!codePresent(hasCode, feature)) return { feature, on: false, reason: "code_absent" };

  const read = readLicence(licence);
  const claims = read.claims;
  const summary = claims ? { licence: { licensee: claims.licensee, seats: claims.seats, exp: claims.exp } } : {};
  if (!read.ok) return { feature, on: false, reason: read.reason, ...summary };
  if (!read.claims.features.includes(feature)) return { feature, on: false, reason: "not_in_licence", ...summary };
  return { feature, on: true, reason: "licensed", ...summary };
}

/** Whether this deployment may run a feature. */
export function isLicensed(feature: EnterpriseFeature, deps: Partial<RegistryDeps> = {}): boolean {
  return enterpriseFeature(feature, deps).on;
}

/** Every Enterprise feature's answer, reading the licence once: for a status screen or the doctor. */
export function enterpriseStatus(deps: Partial<RegistryDeps> = {}): FeatureAnswer[] {
  let read: LicenceResult | undefined;
  const licence = () => (read ??= readLicence(deps.licence ?? DEFAULT_DEPS.licence));
  return ENTERPRISE_FEATURE_IDS.map((feature) => enterpriseFeature(feature, { ...deps, licence }));
}
