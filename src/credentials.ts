import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
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

export function defaultCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const state = env.XDG_STATE_HOME;
  return join(
    state && isAbsolute(state) ? state : join(home, ".local", "state"),
    "teams-chat-download",
    "credentials.json",
  );
}

const projectCredentialsPath = fileURLToPath(
  new URL("../.private/credentials.json", import.meta.url),
);

export async function loadCredentials(path?: string): Promise<Credentials> {
  const candidates =
    path === undefined
      ? [defaultCredentialsPath(), projectCredentialsPath]
      : [path];
  for (const candidate of candidates) {
    try {
      return await readCredentials(candidate);
    } catch (error) {
      // Only absence permits fallback. A broken file must not switch accounts.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        if (path === undefined) continue;
        throw new AppError("Credential file not found at --credentials path.");
      }
      if (error instanceof AppError) throw error;
      throw new AppError("Cannot read credential file as JSON.");
    }
  }
  throw new AppError(
    `No credential file found. Create ${defaultCredentialsPath()} or supply --credentials <file>.`,
  );
}

async function readCredentials(path: string): Promise<Credentials> {
  let data: unknown;
  const info = await stat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new AppError("Credential file must be private: run chmod 600 on it.");
  }
  data = JSON.parse(await readFile(path, "utf8"));
  const result = credentialsSchema.safeParse(data);
  if (!result.success) throw validationError("Credential file", result.error);
  return result.data;
}
