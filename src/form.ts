export interface TrialFormInput {
  fps: number | null;
  jumpType: string | null;
  boxHeightIn: number | null;
  armSwing: boolean | null;
  touchdown: number | null;
  takeoff: number | null;
  landing: number | null;
}

function isFrame(frame: number | null): frame is number {
  return frame !== null && Number.isInteger(frame) && frame >= 0;
}

/** Plain-language reason a trial cannot be saved, or null when it can. */
export function trialFormError(input: TrialFormInput): string | null {
  if (input.fps === null || !Number.isFinite(input.fps) || input.fps <= 0) {
    return "Enter a frame rate above 0.";
  }
  if (input.jumpType !== "drop" && input.jumpType !== "depth") {
    return "Choose drop jump or depth jump.";
  }
  if (input.boxHeightIn === null || !Number.isFinite(input.boxHeightIn) || input.boxHeightIn <= 0) {
    return "Enter a box height in inches.";
  }
  if (input.armSwing === null) {
    return "Say whether the arms swung.";
  }
  if (!isFrame(input.touchdown) || !isFrame(input.takeoff) || !isFrame(input.landing)) {
    return "Mark touchdown, takeoff, and landing.";
  }
  if (!(input.touchdown < input.takeoff && input.takeoff < input.landing)) {
    return "Touchdown, takeoff, and landing have to be in that order.";
  }
  return null;
}
