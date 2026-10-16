/** A finite number from a JSON number or non-blank numeric string. */
export function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Epoch milliseconds from a Date, finite number, or ISO/Gamma timestamp. */
export function timestampMs(value: unknown): number | null {
  if (value instanceof Date) return finiteNumber(value.getTime());
  if (typeof value === "number") return finiteNumber(value);
  if (typeof value !== "string" || !value) return null;
  // Gamma sports timestamps currently use SQL-style ` ` and `+00`; normalize
  // them to the ISO 8601 form whose parsing is portable across browsers.
  const normalized = value
    .replace(/^([0-9]{4}-[0-9]{2}-[0-9]{2}) /, "$1T")
    .replace(/(T[0-9:.]+[+-][0-9]{2})$/, "$1:00");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
