import type { Credentials } from "./credentials.ts";
import { defaultExportPath } from "./export-path.ts";
import type { Http, RequestStats } from "./http.ts";
import type { ExportOptions } from "./options.ts";
import { checkOutput, writeExport } from "./output.ts";
import { type HistoryProgress, listChats, readHistory } from "./teams.ts";

export async function exportChat(
  options: ExportOptions,
  credentials: Credentials,
  http: Http,
  stats: RequestStats,
  progress: HistoryProgress,
  signal?: AbortSignal,
) {
  let out = options.out;
  if (out === undefined) {
    let label: string | undefined;
    if (credentials.directoryToken) {
      const chats = await listChats(http, credentials, {
        chatId: options.chat,
        warn: (message) => console.error(message),
        signal,
      });
      label = chats[0]?.label;
    }
    if (label === undefined)
      console.error(
        "Chat label unavailable; using a chat identifier in the filename.",
      );
    out = defaultExportPath(options, label);
  }
  await checkOutput(out);
  const messages = await readHistory(
    http,
    credentials,
    options.chat,
    options.window,
    progress,
  );
  signal?.throwIfAborted();
  const document = {
    version: 1,
    status: "complete",
    accountId: credentials.accountId,
    chatId: options.chat,
    window: {
      from: new Date(options.window.from).toISOString(),
      toExclusive: new Date(options.window.to).toISOString(),
      timestampField: "originalarrivaltime",
    },
    completedAt: new Date().toISOString(),
    history: {
      ...progress,
      uniqueMessages: messages.length,
      serviceReportedExhaustion: true,
      duplicatePolicy: "identical records deduplicated; conflicts fail",
    },
    requests: {
      ...stats,
      scope:
        "HTTP client attempts; retries included; redirects refused; browser traffic excluded",
    },
    media: { status: "not-downloaded" },
    messages,
  };
  const output = await writeExport(out, document, signal);
  return { output, messages: messages.length };
}
