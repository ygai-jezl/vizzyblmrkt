/**
 * The API reference viewer: Scalar's standalone bundle from jsDelivr, pinned to
 * an exact version and checked with Subresource Integrity — an exact version's
 * file never changes there, so the hash only changes when we upgrade on purpose.
 *
 * To upgrade: `npm view @scalar/api-reference version`, then
 *   curl -sL <src> | openssl dgst -sha384 -binary | openssl base64 -A
 * and update both below.
 */
export const SCALAR_VERSION = "1.72.1";

export const SCALAR_SCRIPT = {
  src: `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`,
  integrity: "sha384-U11tb2XnKvmwt8RlTvnwUnYgrN+ur4Xyh9htLhjajWNR/Oyl5AX5DEz00qRmlrmK",
} as const;
