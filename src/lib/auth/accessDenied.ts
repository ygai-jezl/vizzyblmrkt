/**
 * The sign-in error shown when the server refuses an account (HTTP 403). A
 * deployment where admins sign in with one Google Workspace domain names it in
 * NEXT_PUBLIC_ADMIN_SIGNIN_DOMAIN (message only) or NEXT_PUBLIC_ADMIN_HD (which
 * also limits the account chooser) and keeps the domain wording; everyone else
 * gets a neutral line that says how access is granted.
 */
export function accessDeniedMessage(
  domain: string | undefined = process.env.NEXT_PUBLIC_ADMIN_SIGNIN_DOMAIN || process.env.NEXT_PUBLIC_ADMIN_HD,
): string {
  const d = domain?.trim();
  if (d) return `Access denied. Sign in with your @${d} account.`;
  return "Access denied. This account isn't on the admin list. An admin can add it to ADMIN_ALLOWED_EMAILS.";
}

/**
 * The sign-in error when the account is allowed but the deployment hasn't named the
 * workspace first-time admins join (ADMIN_BOOTSTRAP_TENANT_ID is unset).
 */
export const WORKSPACE_NOT_SET_UP_MESSAGE =
  "This workspace isn't set up yet. Whoever runs it needs to set ADMIN_BOOTSTRAP_TENANT_ID to the tenant new admins join. Then sign in again.";

/**
 * The small line under the sign-in button. Deployments that name a sign-in domain
 * (see accessDeniedMessage) keep the Workspace wording; everyone else gets a line
 * that matches how access works there (the admin list).
 */
export function signInNote(
  domain: string | undefined = process.env.NEXT_PUBLIC_ADMIN_SIGNIN_DOMAIN || process.env.NEXT_PUBLIC_ADMIN_HD,
): string {
  return domain?.trim()
    ? "Restricted to your Google Workspace accounts."
    : "Only accounts on this workspace's admin list can sign in.";
}
