// URL parsers resolve "." and ".." segments even when percent-encoded, so these values can't be sent.
export function pathSegment(value: unknown): string {
  const segment = String(value);
  if (segment === "." || segment === "..") {
    throw new TypeError(`Path parameter "${segment}" cannot be sent: URLs treat it as a relative path segment`);
  }
  return encodeURIComponent(segment);
}
