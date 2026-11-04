import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { AppError, validationError } from "./errors.ts";

const header = z
  .string()
  .min(1)
  .regex(/^[^\r\n]+$/);
const credentialsSchema = z.strictObject({
  version: z.literal(1),
  accountId: z.string().min(1),
  historyAuthentication: header.optional(),
  directoryToken: header.optional(),
});

export type Credentials = z.infer<typeof credentialsSchema>;

export async function loadCredentials(path: string): Promise<Credentials> {
  let data: unknown;
  try {
    const info = await stat(path);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new AppError(
        "Credential file must be private: run chmod 600 on it.",
      );
    }
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Cannot read credential file as JSON.");
  }
  const result = credentialsSchema.safeParse(data);
  if (!result.success) throw validationError("Credential file", result.error);
  return result.data;
}
