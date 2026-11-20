/**
 * Switches for what Disconnect does at the provider. Server only. Off = Disconnect
 * removes the connection from YouGrow and calls no provider, as before.
 */

/** Disconnect also cancels YouGrow's access at GitLab and on an older (classic) GitHub
 *  connection, and a reconnect cancels the token it replaces. Never uninstalls a GitHub
 *  App, never touches LinkedIn. */
export function isConnectorRevokeEnabled(): boolean {
  return process.env.CONNECTOR_REVOKE_ENABLED === "true";
}

/** Disconnect also cancels YouGrow's access at X, and X tokens minted by a refresh that
 *  finds the connection gone are cancelled. Needs CONNECTOR_REVOKE_ENABLED. Its own
 *  switch because an X account connected to two brands may share one grant. */
export function isConnectorRevokeXEnabled(): boolean {
  return isConnectorRevokeEnabled() && process.env.CONNECTOR_REVOKE_X_ENABLED === "true";
}
