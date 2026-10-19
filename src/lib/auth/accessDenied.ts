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
