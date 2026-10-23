import { describe, expect, it } from "vitest";
import { DEFAULT_CHART_MODE, loadChartModePref, saveChartModePref } from "./chartModePref.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe("chartModePref", () => {
  it("defaults to mean by date and remembers every-jump", () => {
    expect(DEFAULT_CHART_MODE).toBe("mean");
    const store = memoryStore();
    expect(loadChartModePref(store)).toBe("mean");
    saveChartModePref(store, "every");
    expect(loadChartModePref(store)).toBe("every");
  });
});
