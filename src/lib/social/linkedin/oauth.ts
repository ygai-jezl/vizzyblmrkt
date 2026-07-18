import { socialOrigin } from "@/lib/social/x/oauth";

/**
 * LinkedIn OAuth 2.0 (Authorization Code) config + pure helpers. Unlike X, LinkedIn
 * does NOT use PKCE — it's a confidential client that passes client_id/client_secret
 * in the token-exchange BODY (not Basic auth). Identity (the member URN for posting)
 * comes from the OpenID `/v2/userinfo` `sub`. Scopes need app-product approval
 * ("Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn").
 */

export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
/** openid/profile → the member `sub` (author URN); w_member_social → post to the feed. */
export const LINKEDIN_SCOPES = "openid profile w_member_social";
export const LINKEDIN_OAUTH_PATH = "/api/admin/integrations/linkedin/callback";
/** httpOnly cookie carrying the state NONCE from /start to /callback. LinkedIn needs
 *  no PKCE, but binding the flow to the initiating browser (cookie nonce === state.n)
 *  defeats OAuth account-fixation — a signed tenant-state alone is cross-session replayable. */
export const LINKEDIN_STATE_COOKIE = "li_oauth_state";

export { socialOrigin };

export function linkedinClientId(): string | undefined {
  return process.env.LINKEDIN_OAUTH_CLIENT_ID;
}
export function linkedinClientSecret(): string | undefined {
  return process.env.LINKEDIN_OAUTH_CLIENT_SECRET;
}

/** The LinkedIn OAuth app is configured (client id + secret present). */
export function isLinkedInConfigured(): boolean {
  return Boolean(linkedinClientId() && linkedinClientSecret());
}

// ── Community Management API (App 2) — Company Page / organization posting ────────
// A SEPARATE LinkedIn app (CM must be the only product on its app) → its own
// credentials + scopes. Same authorize/token endpoints (the app is keyed by client_id).
export const LINKEDIN_ORG_OAUTH_PATH = "/api/admin/integrations/linkedin_org/callback";
export const LINKEDIN_ORG_STATE_COOKIE = "li_org_state";
/** rw_organization_admin → list the Pages the member admins (organizationAcls) +
 *  manage Page data; w_organization_social → post as the Page. No OpenID (CM-only app).
 *  NB: the Community Management product grants `rw_organization_admin` — `r_organization_admin`
 *  is an Advertising-API scope and requesting it on a CM-only app 400s (unauthorized_scope). */
export const LINKEDIN_ORG_SCOPES = "rw_organization_admin w_organization_social";
export const LINKEDIN_ORG_ACLS_URL =
  "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED";

export function linkedinCmClientId(): string | undefined {
  return process.env.LINKEDIN_CM_CLIENT_ID;
}
export function linkedinCmClientSecret(): string | undefined {
  return process.env.LINKEDIN_CM_CLIENT_SECRET;
}
export function isLinkedInCMConfigured(): boolean {
  return Boolean(linkedinCmClientId() && linkedinCmClientSecret());
}

/** The author URN for an organization (Company Page) post. */
export function organizationUrn(id: string): string {
  return `urn:li:organization:${id}`;
}

/** Build the LinkedIn authorize URL for the redirect. */
export function buildLinkedInAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL(LINKEDIN_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope ?? LINKEDIN_SCOPES);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export interface LinkedInTokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  token_type?: string;
}

/** The author URN LinkedIn posts are attributed to, from the OpenID `sub`. */
export function personUrn(sub: string): string {
  return `urn:li:person:${sub}`;
}
