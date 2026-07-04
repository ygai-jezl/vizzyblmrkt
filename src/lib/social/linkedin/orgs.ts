import { LINKEDIN_ORG_ACLS_URL } from "./oauth";

/**
 * Discover the LinkedIn Company Pages a member ADMINISTERS, for the "post as Page"
 * picker. Reads organizationAcls (role=ADMINISTRATOR, state=APPROVED) with a
 * Community Management token, then best-effort resolves each org's display name.
 * Pure over an injectable fetch. Fail-soft: any failure → [] (the operator just
 * sees no pages rather than a broken connect).
 */
const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION ?? "202606";
const ORG_LOOKUP_BASE = "https://api.linkedin.com/rest/organizations";
const MAX_ORGS = 25;
const CALL_TIMEOUT_MS = 8000;

export interface LinkedInOrgResult {
  urn: string;
  name: string | null;
}

/** `ok` distinguishes "the ACLs call FAILED (unknown)" from "genuinely 0 admin orgs".
 *  The caller preserves a prior page list on ok=false rather than clobbering with []. */
export interface FetchOrgsOutcome {
  ok: boolean;
  orgs: LinkedInOrgResult[];
}

export interface FetchOrgsDeps {
  fetch?: typeof fetch;
  aclsUrl?: string;
  orgLookupBase?: string;
  version?: string;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export async function fetchAdminOrganizations(
  accessToken: string,
  deps: FetchOrgsDeps = {},
): Promise<FetchOrgsOutcome> {
  if (!accessToken) return { ok: false, orgs: [] };
  const doFetch = deps.fetch ?? fetch;
  const version = deps.version ?? LINKEDIN_VERSION;
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "linkedin-version": version,
    "x-restli-protocol-version": "2.0.0",
    accept: "application/json",
  };

  let aclData: Obj | null;
  try {
    const res = await doFetch(deps.aclsUrl ?? LINKEDIN_ORG_ACLS_URL, {
      headers,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, orgs: [] }; // ACLs failed → unknown, don't clobber prior
    aclData = asObj(await res.json().catch(() => null));
  } catch {
    return { ok: false, orgs: [] };
  }

  const elements = Array.isArray(aclData.elements) ? aclData.elements : [];
  const urns = [
    ...new Set(elements.map((e) => str(asObj(e).organization)).filter((u): u is string => Boolean(u))),
  ].slice(0, MAX_ORGS);

  const base = deps.orgLookupBase ?? ORG_LOOKUP_BASE;
  const orgs = await Promise.all(
    urns.map(async (urn) => {
      const id = urn.split(":").pop() ?? "";
      // Org ids are numeric; skip the name lookup (keep the org, name:null) for anything
      // else rather than interpolating an unexpected segment into the URL.
      if (!/^\d+$/.test(id)) return { urn, name: null };
      try {
        const r = await doFetch(`${base}/${encodeURIComponent(id)}`, {
          headers,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        if (!r.ok) return { urn, name: null };
        const o = asObj(await r.json().catch(() => null));
        // The organizations API returns a convenience `localizedName`.
        const name = str(o.localizedName) ?? str(asObj(asObj(o.name).localized).en_US) ?? null;
        return { urn, name };
      } catch {
        return { urn, name: null };
      }
    }),
  );
  return { ok: true, orgs };
}
