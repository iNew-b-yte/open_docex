/**
 * Link allowlist for the `link` mark (LLD Part 1 §8.1, §0 R-11).
 *
 * Links are user and import input that ends up in an `<a href>`, so only absolute
 * `http:`, `https:` and `mailto:` URLs are accepted. Relative links are rejected
 * (LLD choice). The string is stored exactly as given; it is never rewritten.
 */

/** Longest href accepted, in UTF-16 code units. */
const MAX_HREF_LENGTH = 2048;

/** Whitespace, C0 controls (U+0000–U+001F), DEL and C1 controls (U+007F–U+009F). */
const FORBIDDEN_CHARS = /[\s\u0000-\u001F\u007F-\u009F]/u;

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns true only when `href` is a string of 1–2048 characters with no whitespace or
 * control characters, parses as an absolute URL, and uses `http:`, `https:` or `mailto:`.
 */
export function isAllowedHref(href: unknown): href is string {
  if (typeof href !== 'string' || href.length === 0 || href.length > MAX_HREF_LENGTH) return false;
  if (FORBIDDEN_CHARS.test(href)) return false;
  let protocol: string;
  try {
    protocol = new URL(href).protocol;
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(protocol);
}
