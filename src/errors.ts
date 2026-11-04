import { z } from "zod";

export class AppError extends Error {}

export function validationError(context: string, error: z.ZodError): AppError {
  const paths = [
    ...new Set(error.issues.map((issue) => issue.path.join(".") || "input")),
  ];
  return new AppError(`${context}: invalid ${paths.join(", ")}.`);
}

export function errorMessage(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : "Operation failed unexpectedly; no complete export was written.";
}
