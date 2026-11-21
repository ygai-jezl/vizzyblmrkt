/**
 * What went wrong with a connection, as a code and the words people see. Codes are stored on a
 * connection's health and activity; a provider's own words never are (they can echo a token or a
 * query). The screens and the help page quote these messages. House style: no dashes.
 */

export const CONNECTOR_ERRORS = {
  token_refused: "The provider turned the token down. Make a new one with the same read permission and connect again.",
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
} as const;

export type ConnectorErrorCode = keyof typeof CONNECTOR_ERRORS;

export function isConnectorErrorCode(code: unknown): code is ConnectorErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(CONNECTOR_ERRORS, code);
}

/** The words for a code, or a plain fallback for one this build doesn't know. */
export function connectorMessage(code: string | null | undefined): string {
  return isConnectorErrorCode(code) ? CONNECTOR_ERRORS[code] : "Something went wrong with this connection. Check it again, or connect it again.";
}
