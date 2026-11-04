import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AppError, validationError } from "./errors.ts";

const timestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));

export const messageSchema = z.looseObject({
  id: z.string().min(1),
  originalarrivaltime: timestamp,
});

// Validate the versioned fields used by renderers; retain additive source fields.
const archiveSchema = z.looseObject({
  version: z.literal(1),
  status: z.literal("complete"),
  chatId: z.string().min(1),
  window: z.looseObject({
    from: timestamp,
    toExclusive: timestamp,
    timestampField: z.literal("originalarrivaltime"),
  }),
  media: z.looseObject({ status: z.literal("not-downloaded") }),
  messages: z.array(messageSchema),
});

export type Archive = z.infer<typeof archiveSchema>;
export type Message = z.infer<typeof messageSchema>;

export async function readArchive(
  path: string,
  signal?: AbortSignal,
): Promise<Archive> {
  let raw: string;
  try {
    raw = await readFile(path, { encoding: "utf8", signal });
  } catch {
    throw new AppError("Could not read the input JSON export.");
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new AppError("Input export is not valid JSON.");
  }
  const result = archiveSchema.safeParse(input);
  if (!result.success)
    throw validationError("Version 1 JSON export", result.error);
  const archive = result.data;
  const from = Date.parse(archive.window.from);
  const to = Date.parse(archive.window.toExclusive);
  if (from < 0 || from >= to)
    throw new AppError("Input export has an invalid date window.");
  if (
    archive.messages.some((message) => {
      const time = Date.parse(message.originalarrivaltime);
      return time < from || time >= to;
    })
  )
    throw new AppError(
      "Input export contains a message outside its date window.",
    );
  return archive;
}
