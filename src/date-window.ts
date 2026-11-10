import { AppError } from "./errors.ts";

export type Window = { from: number; to: number };

export function assertWindow(window: Window): void {
  if (
    !Number.isSafeInteger(window.from) ||
    !Number.isSafeInteger(window.to) ||
    window.from < 0 ||
    window.to > 8_640_000_000_000_000 ||
    window.from >= window.to
  ) {
    throw new AppError(
      "The date window must be nonempty, ordered, and representable as nonnegative millisecond timestamps.",
    );
  }
}
