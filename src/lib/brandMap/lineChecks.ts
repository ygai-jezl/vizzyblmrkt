/**
 * Checks on what goes into, and comes back from, the map's model calls at any size (research
 * steps, buying situations, an uploaded PDF, sorting into groups). Everything listed in a
 * prompt is someone's words (the web, a forum, a file), so it is folded to one line and kept
 * inside its tags; a line the model writes is dropped when it holds a web address, an email
 * or a phone number. Pure.
 */

/** Folded to one line. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** One field of a model's answer: folded, with quotes and stars at its ends taken off. */
export const clean = (s: string) => oneLine(s).replace(/^["“”'*]+|["“”'*]+$/g, "").trim();

/** Text listed inside `<tag>`, with that tag taken out of it so it can't close the fence early. */
export const fence = (tag: string, text: string) => text.replace(new RegExp(`</?\\s*${tag}[^>]*>`, "gi"), " ");

// A named list, not any letters: "Node.js/Deno" or "and/or" are words, not addresses.
const TLDS = [
  "com", "net", "org", "io", "ai", "co", "dev", "app", "info", "biz", "xyz", "me", "tv", "ly", "gg", "so", "sh",
  "site", "online", "store", "shop", "tech", "blog", "page", "news", "cloud", "edu", "gov",
  "uk", "eu", "us", "ca", "au", "nz", "ie", "de", "fr", "es", "it", "nl", "be", "ch", "at", "se", "no", "dk",
  "fi", "pl", "pt", "cz", "gr", "ro", "hu", "tr", "il", "in", "jp", "cn", "kr", "sg", "hk", "tw", "br", "mx", "ar", "za",
].join("|");
const ADDRESS = new RegExp(`https?:\\/\\/|www\\.|\\b[a-z0-9-]+\\.(?:${TLDS})\\/\\S`, "i");

/** A web address: a scheme, "www.", or a domain followed by a path (example.de/page, example.co.uk/page). */
export const hasAddress = (s: string) => ADDRESS.test(s);

export const hasEmail = (s: string) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(s);

/** International numbers, North American ones, and UK-style ones starting with 0. */
export const hasPhone = (s: string) => /\+\d[\d\s().-]{7,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b0\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/.test(s);
