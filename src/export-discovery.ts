import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Bounded discovery covers legacy flat exports and the chat/period layout.
// Candidates may be absent or symlinks; callers must lstat before reading.
export async function* exportArchiveCandidates(
  directory: string,
  onUnreadableFolder?: () => void,
): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && /\.json$/i.test(entry.name)) yield path;
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      entry.name.endsWith(".lock")
    )
      continue;
    yield join(path, "chat.json");
    const periods = await readdir(path, { withFileTypes: true }).catch(
      (error) => {
        if (!onUnreadableFolder) throw error;
        onUnreadableFolder();
        return [];
      },
    );
    periods.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const period of periods) {
      if (
        period.isDirectory() &&
        /^(?:\d{4}-\d{2}-\d{2}$|last-[1-9]\d*d--to-|from-|since-)/.test(
          period.name,
        )
      )
        yield join(path, period.name, "chat.json");
    }
  }
}
