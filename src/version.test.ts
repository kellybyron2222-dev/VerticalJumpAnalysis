import { describe, expect, it } from "vitest";
import { BUILD_ID } from "./version.ts";

describe("build id", () => {
  it("is a dated deploy stamp", () => {
    expect(BUILD_ID).toMatch(/^\d{4}-\d{2}-\d{2}[a-z]$/);
  });
});
