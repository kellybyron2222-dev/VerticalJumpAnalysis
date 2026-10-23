export type ChartMode = "mean" | "every";

export const CHART_MODE_PREF_KEY = "jumpLab.chartMode.v1";
export const DEFAULT_CHART_MODE: ChartMode = "mean";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseChartMode(raw: string | null | undefined): ChartMode {
  return raw === "every" ? "every" : "mean";
}

export function loadChartModePref(storage: KeyValueStore): ChartMode {
  try {
    return parseChartMode(storage.getItem(CHART_MODE_PREF_KEY));
  } catch {
    return DEFAULT_CHART_MODE;
  }
}

export function saveChartModePref(storage: KeyValueStore, value: ChartMode): boolean {
  try {
    storage.setItem(CHART_MODE_PREF_KEY, value);
    return true;
  } catch {
    return false;
  }
}
