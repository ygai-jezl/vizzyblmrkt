/**
 * The order guards: where doing things in the wrong order used to fail quietly,
 * the app now stops and says so. A welcome email's first publish asks before it
 * goes to everyone already on the list; a post can't be scheduled to LinkedIn
 * or X with no account connected; a launch says when its emails still come from
 * the shared default address. Server-only. Off = the app behaves as before.
 */
export function isOrderGuardsEnabled(): boolean {
  return process.env.ORDER_GUARDS_ENABLED === "true";
}
