/**
 * Why a connection attempt failed, in plain words, for the banner on Settings › Connections.
 * The reason comes from the start or callback route's redirect (?status=error&reason=...),
 * and the label names the service it was for, so a LinkedIn failure never says GitHub.
 */
export const CONNECT_REASONS = [
  "installation_not_yours",
  "app_not_read_only",
  "no_installation",
  "installations_lookup_failed",
  "token_exchange_failed",
  "bad_state",
  "bad_pkce",
  "state_expired",
  "access_denied",
  "denied",
  "user_cancelled_login",
  "user_cancelled_authorize",
  "missing_code",
  "insufficient_scope",
  "no_member_id",
  "exception",
  "x_not_configured",
  "linkedin_not_configured",
  "linkedin_cm_not_configured",
  "unknown_provider",
  "forbidden",
] as const;

export type ConnectReason = (typeof CONNECT_REASONS)[number];

const NOT_SET_UP = "Not set up on this YouGrow yet. Whoever runs it can add its app keys.";
const START_AGAIN = "That connection attempt expired or came from another session. Please start again from here.";
const cancelled = (label: string) => `The connection was cancelled on ${label}.`;

const MESSAGES: Record<ConnectReason, (label: string) => string> = {
  installation_not_yours: () =>
    "That GitHub installation isn't one your account can access. Install the app from here, signed in as a member of that account.",
  app_not_read_only: () =>
    "That GitHub installation has more than read access, so we refused it. Reinstall the YouGrow app from here.",
  no_installation: () => "GitHub didn't finish installing the app. Try Connect again, and choose where to install it.",
  installations_lookup_failed: () => "GitHub didn't tell us which installations you can access. Please try again.",
  token_exchange_failed: (label) => `${label} didn't confirm the connection. Please try again.`,
  bad_state: () => START_AGAIN,
  bad_pkce: () => START_AGAIN,
  state_expired: () => "That connection attempt expired. Please start again from here.",
  access_denied: cancelled,
  denied: cancelled,
  user_cancelled_login: cancelled,
  user_cancelled_authorize: cancelled,
  missing_code: (label) => `${label} didn't send back a sign-in code. Please start again from here.`,
  insufficient_scope: (label) => `${label} didn't grant all the access we asked for. Connect again and allow it.`,
  no_member_id: (label) => `${label} didn't tell us which account you signed in with. Please try again.`,
  exception: (label) => `Something went wrong connecting ${label}. Please try again.`,
  x_not_configured: () => NOT_SET_UP,
  linkedin_not_configured: () => NOT_SET_UP,
  linkedin_cm_not_configured: () => NOT_SET_UP,
  unknown_provider: () => "That service can't be connected here.",
  forbidden: () => "Only admins can connect accounts. Ask an admin on your team.",
};

const isReason = (r: string): r is ConnectReason => (CONNECT_REASONS as readonly string[]).includes(r);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The banner text for a failed connection. `label` is the service's name, if known. */
export function connectErrorMessage(reason: string, label?: string | null): string {
  const name = label?.trim() || "the service";
  if (isReason(reason)) return capitalise(MESSAGES[reason](name));
  return `Couldn't connect ${name} (${reason}).`;
}
