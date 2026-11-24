/** A page as one way of writing it: the path only, no query string or fragment. */
export function cleanPagePath(raw: string): string {
  let path = raw.trim();
  try {
    path = new URL(path, "https://page.invalid").pathname;
  } catch {
    path = path.split(/[?#]/)[0] ?? "";
  }
  return path.startsWith("/") ? path : `/${path}`;
}
