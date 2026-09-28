export function sameDisplayTitle(
  a: string,
  b: string | null | undefined,
): boolean {
  if (!b) return false;
  return normalizeDisplayTitle(a) === normalizeDisplayTitle(b);
}

function normalizeDisplayTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
