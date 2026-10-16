/** `?pressureDebug=1` enables pressure pipeline diagnostics. */
export const PRESSURE_DEBUG =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("pressureDebug") === "1";
