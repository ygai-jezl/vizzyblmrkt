import { dayWords } from "./period";

/**
 * What went wrong with a connection, as a code and the words people see. Codes are stored on a
 * connection's health and activity; a provider's own words never are (they can echo a token or a
 * query). The screens and the help page quote these messages. House style: no dashes.
 */

/**
 * The product people name, as the approved screens write it: "Search Console" for Google Search
 * Console, "Google Analytics" for Google Analytics 4; any other tool by its own name.
 */
export function productName(name: string): string {
  return name.replace(/^Google (Search Console)$/, "$1").replace(/^(Google Analytics) 4$/, "$1");
}

export const CONNECTOR_ERRORS = {
  token_refused: "The provider turned the token down. Make a new one with the same read permissions and connect again.",
  account_refused: "The token can't read that account. Check the ID you pasted, and that the token includes it.",
  rate_limited: "The provider asked YouGrow to slow down, so calls are paused for a while. They start again by themselves.",
  provider_error: "The provider had a problem answering. YouGrow tries again on the next check.",
  timeout: "The provider took too long to answer. Try again in a minute.",
  network: "YouGrow couldn't reach the provider. Try again in a minute.",
  redirect_refused: "The provider sent the call somewhere else. YouGrow never follows that with your token, so nothing was read.",
  body_too_large: "The answer was too big to read. Ask for fewer days.",
  bad_response: "The provider's answer wasn't what YouGrow expected, so nothing was read.",
  query_refused: "The provider refused the question, often because the days are further back than your plan with them keeps.",
  host_not_allowed: "YouGrow stopped a call to an address this connector doesn't list.",
  busy: "This connection was asked a lot in the last few minutes. Try again shortly.",
  paused: "This connection is paused. An admin can resume it.",
  vault_unconfigured: "This copy of YouGrow has no key to seal tokens yet (CONNECTORS_VAULT_KEY). Ask whoever runs it to set one.",
  secret_unopenable: "YouGrow can't open this connection's saved token any more. Connect it again.",
  disconnected: "This connection was disconnected. Connect again to read its numbers.",
  signin_refused: "Google asked YouGrow to sign in again, often because access was removed in the Google account or the sign in ran out. Reconnect to sign in again.",
  signin_unconfigured: "This copy of YouGrow has no working Google sign in yet (CONNECTOR_GOOGLE_CLIENT_ID and its secret). Ask whoever runs it to set one up.",
  account_needed: "Pick which site or property this connection reads first.",
  share_not_visible:
    "We can't see your property yet. Check that you added the address exactly as shown, with the role shown, then press Check access again. A new address can take a few minutes to start working.",
  share_access_lost: "YouGrow lost access to this property. Add the Google address again with the role shown, then press Check access.",
  share_pending: "Google is still setting up this connection's address. Wait a minute, then press Check access again.",
  share_unconfigured:
    "This copy of YouGrow can't use shared access right now (CONNECTORS_IDENTITIES_PROJECT, or an API or permission in that project). Ask whoever runs it to check, or sign in with Google instead.",
  share_quota:
    "YouGrow can't make a new address for shared access right now, because its Google project holds as many as Google allows. Sign in with Google instead, or try again later.",
  share_limit:
    "This brand already has 5 shared Google addresses for this connector, the most one brand can have. Disconnect a shared connection you no longer use, or sign in with Google instead.",
} as const;

export type ConnectorErrorCode = keyof typeof CONNECTOR_ERRORS;

export function isConnectorErrorCode(code: unknown): code is ConnectorErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(CONNECTOR_ERRORS, code);
}

/**
 * A turned down token in the words of its tool (owner, 22 Nov, as the approved Connected screen):
 * which tool turned it down, and what to do, the tool's name coming from its manifest.
 * - On a connection (the Connected banner, its panel, Check now, Vizzy's list): nothing is read
 *   until someone reconnects. `chat` is whether Vizzy reads connected data, so it is named only then.
 * - While connecting (Check or Connect on a Listing): nothing was saved, so try again.
 */
export function tokenRefusedMessage(name: string, when: "connected" | "connecting", chat: boolean): string {
  if (when === "connecting") return `${name} turned the token down, so nothing was saved. Paste the whole token again, or make a new one with the permissions listed here.`;
  return `${name} turned the token down. ${chat ? "Vizzy can't read it" : "Nobody can read it"} until you reconnect.`;
}

/**
 * A shared connection that had worked, whose Google address was taken off the property later
 * (Connectors 2: the daily collect notices it the next day), dated when the failures began.
 */
export function accessLostMessage(since: string): string {
  return `YouGrow lost access to this property on ${dayWords(since.slice(0, 10))}. Add the Google address again with the role shown, then press Check access.`;
}

/**
 * The words for a code, or a plain fallback for one this build doesn't know. With `about`, the
 * connection's tool and whether Vizzy reads connected data, a turned down token names its tool,
 * and lost access is dated by `since`, when the failures began.
 */
export function connectorMessage(code: string | null | undefined, about?: { name: string; chat: boolean; since?: string | null }): string {
  if (code === "token_refused" && about) return tokenRefusedMessage(about.name, "connected", about.chat);
  if (code === "share_access_lost" && about?.since) return accessLostMessage(about.since);
  return isConnectorErrorCode(code) ? CONNECTOR_ERRORS[code] : "Something went wrong with this connection. Check it again, or connect it again.";
}

/**
 * Why a sign in with Google didn't finish: the callback sends people back with one of these as
 * `reason`, and the screens and the help page quote the words.
 */
export const SIGNIN_REASONS = {
  forbidden: "Only a brand's admins can connect data.",
  bad_state: "This sign in didn't match the brand it started in. Start again from Settings › Connections › Browse.",
  wrong_admin: "Another admin started this sign in, so only they can finish it. Start your own from Settings › Connections › Browse.",
  wrong_browser: "This sign in started in another browser, or its cookie ran out. Start again in this browser.",
  state_expired: "The sign in took longer than 10 minutes. Start again.",
  state_used: "This sign in was finished already. Start again if you need another.",
  denied: "Access wasn't given on Google's screen, so nothing was connected.",
  google_error: "Google stopped the sign in. Try again, or ask whoever runs YouGrow to check its Google setup.",
  missing_code: "Google didn't send the sign in back. Start again.",
  connector_off: "This connector isn't turned on here any more.",
  signin_unconfigured: CONNECTOR_ERRORS.signin_unconfigured,
  vault_unconfigured: CONNECTOR_ERRORS.vault_unconfigured,
  exchange_failed: "Google wouldn't finish the sign in. Start again.",
  scope_not_granted: "The permission to read your numbers was left unticked on Google's screen. Sign in again and tick it.",
  scope_too_wide: "Google gave YouGrow more access than it asked for, so nothing was saved. Start again.",
  no_refresh_token: "Google didn't give YouGrow a lasting sign in. Start again, and if it happens again, remove YouGrow in your Google account first.",
  check_failed: "You signed in, but the first check didn't go through, so nothing was saved. Try again in a minute.",
  site_not_visible: "This Google account can't see the site this connection reads. Sign in with the account that has access to it.",
} as const;

export type SignInReason = keyof typeof SIGNIN_REASONS;
