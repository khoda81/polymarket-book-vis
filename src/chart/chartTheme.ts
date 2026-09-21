import type { ChartTheme } from "@/lib/renderer";

export const LIGHT_CHART_THEME: ChartTheme = {
  bg: "#ffffff",
  grid: "rgba(128,128,128,0.15)",
  axis: "rgba(128,128,128,0.5)",
  text: "#666666",
};

export const DARK_CHART_THEME: ChartTheme = {
  bg: "#121212",
  grid: "rgba(255,255,255,0.1)",
  axis: "rgba(255,255,255,0.3)",
  text: "#aaaaaa",
};

export function chartThemeForDarkMode(dark: boolean): ChartTheme {
  return dark ? DARK_CHART_THEME : LIGHT_CHART_THEME;
}
