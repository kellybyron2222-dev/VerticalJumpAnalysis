export function formatMilliseconds(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

export function formatHeightIn(inches: number): string {
  return `${inches.toFixed(2)} in`;
}

export function formatHeightCm(cm: number): string {
  return `${cm.toFixed(1)} cm`;
}

export function formatRsi(rsi: number): string {
  return `${rsi.toFixed(2)} m/s`;
}

export function formatClock(seconds: number): string {
  return `${seconds.toFixed(3)} s`;
}

/** Box height. Drops trailing zeros so 12 stays "12 in" and 12.5 stays "12.5 in". */
export function formatBoxInches(inches: number): string {
  const rounded = Math.round(inches * 100) / 100;
  const text = rounded.toFixed(2).replace(/\.?0+$/, "");
  return `${text} in`;
}

export function formatJumpType(jumpType: "drop" | "depth"): string {
  return jumpType === "drop" ? "Drop jump" : "Depth jump";
}

export function formatArmSwing(armSwing: boolean): string {
  return armSwing ? "Arm swing" : "No arm swing";
}
