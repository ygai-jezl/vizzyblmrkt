/**
 * YouGrow's origin, shared by the client (its requests go to `${origin}/api/v2/…`)
 * and the verifier (tokens carry `iss: origin`; keys are at
 * `${origin}/.well-known/jwks.json`). Pass the same value to both, e.g. from
 * YOUGROW_ORIGIN, when you're connected to another YouGrow instance.
 */

export const DEFAULT_ORIGIN = "https://yougrow.ai";

/** Without trailing slashes. Unset or empty means DEFAULT_ORIGIN. */
export function originOf(value: string | undefined): string {
  return (value || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

/** https, or plain http on localhost for local development. */
export function isSecureOrigin(origin: string): boolean {
  return /^https:\/\//.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
