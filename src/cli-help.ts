import type { cac } from "cac";

type Cli = ReturnType<typeof cac>;
type Section = { title?: string; body: string };

const commonCommands = [
  "login",
  "chats",
  "status",
  "collect",
  "images",
  "export",
];
const examples: Record<string, [string, string][]> = {
  chats: [
    ["Show chats you have not collected yet", "chats --new"],
    ["Show every chat, newest activity first", "chats"],
  ],
  status: [["Show what is saved, offline", "status"]],
  collect: [
    [
      "Catch up all saved chats, including images",
      "collect --all-chats --images",
    ],
    [
      "Start collecting a new chat",
      'collect --chat-label "Chat name" --all-history --images',
    ],
    ["Catch up one saved chat, text only", 'collect --chat-label "Chat name"'],
  ],
  export: [
    [
      "Export all saved chats, including saved images",
      "export --all-chats --last 5d",
    ],
    [
      "Export daily JSON and Markdown folders offline",
      'export --chat-label "Chat name" --last 7d',
    ],
    [
      "Export all saved history to a new folder",
      'export --chat-label "Chat name" --out exports/chat-history',
    ],
  ],
  images: [
    ["Download pending images for all saved chats", "images"],
    ["Download pending images for one chat", 'images --chat-label "Chat name"'],
  ],
  download: [
    [
      "Collect, download images, and export in one command",
      'download --chat-label "Chat name" --last 7d',
    ],
  ],
};

const behavior: Record<string, string> = {
  collect:
    "Without date flags, catch up from each chat's saved coverage through now.\nNew chats need --all-history or a date range. Completed intervals are skipped.\nImages are opt-in with --images. Export JSON/Markdown separately with export.\nDates such as 2026-11-01 mean local midnight; --to is exclusive.",
  export:
    "Offline: reads saved messages and images without credentials or HTTP.\nUse --all-chats --last Nd for every saved chat, or select one chat.\nChoose --last Nd for daily folders, or --out for one chat's combined bundle.\nJSON and Markdown include saved images by default; no image downloads occur.",
  chats:
    "Reads the chat list from Teams and marks chats already saved in your database.\nUse a CHAT label with --chat-label, or the ID with --chat where noted.",
  status:
    "Offline: reads the collection database without credentials or HTTP.\nLists saved labels for --chat-label, collected ranges, gaps, and pending images.",
  images:
    "With no chat selector, process all saved chats. Verified images are skipped.\nDownloads files beside the database; does not export JSON or Markdown.",
  download:
    "Combines collection, image downloading, and JSON/Markdown export for one chat.\nChoose one date mode. For separate collection and export, use collect and export.",
};

function rows(entries: [string, string][]): string {
  const width = Math.max(0, ...entries.map(([name]) => name.length));
  return entries
    .flatMap(([name, description]) => {
      const prefix = `  ${name.padEnd(width)}  `;
      const lines: string[] = [];
      let line = prefix;
      for (const word of description.split(/\s+/)) {
        if (line.length + word.length + 1 > 88 && line !== prefix) {
          lines.push(line);
          line = " ".repeat(prefix.length);
        }
        line += `${line.endsWith(" ") ? "" : " "}${word}`;
      }
      lines.push(line.trimEnd());
      return lines;
    })
    .join("\n");
}

export function configureCliHelp(cli: Cli): void {
  cli.help((generated) => {
    const sections: Section[] = generated.filter((section) => !section.title);
    const command = cli.matchedCommand;
    sections.push({
      title: "Usage",
      body: `  ${cli.name} ${command ? `${command.rawName} [options]` : "<command> [options]"}`,
    });

    if (!command) {
      sections.push({
        title: "Common workflows",
        body: [
          examples.collect![0]!,
          examples.collect![1]!,
          examples.export![0]!,
        ]
          .map(([label, args]) => `  ${label}\n    ${cli.name} ${args}`)
          .join("\n\n"),
      });
      const common = commonCommands.flatMap((name) =>
        cli.commands.filter((item) => item.name === name),
      );
      sections.push({
        title: "Common commands",
        body: rows(common.map((item) => [item.name, item.description])),
      });
      sections.push({
        title: "Other commands",
        body: rows(
          cli.commands
            .filter((item) => !commonCommands.includes(item.name))
            .map((item) => [item.name, item.description]),
        ),
      });
      const aliases = cli.commands.flatMap((item) =>
        item.aliasNames.map((alias) => `${alias} -> ${item.name}`),
      );
      sections.push({
        title: "More help",
        body: `  ${cli.name} <command> --help\n  Aliases: ${aliases.join(", ")}`,
      });
    } else {
      sections.push({ body: `  ${command.description}` });
      const usage = examples[command.name];
      if (usage)
        sections.push({
          title: "Common usage",
          body: usage
            .map(([label, args]) => `  ${label}\n    ${cli.name} ${args}`)
            .join("\n\n"),
        });
      if (behavior[command.name])
        sections.push({
          title: "How it works",
          body: behavior[command.name]!.split("\n")
            .map((line) => `  ${line}`)
            .join("\n"),
        });
    }

    // Render registered options rather than duplicating their flags or defaults.
    const remaining = [
      ...(command?.options ?? []),
      ...cli.globalCommand.options,
    ].filter((option) => !command || option.name !== "version");
    const groups: [string, string[]][] = [
      [
        command?.name === "images"
          ? "Select chats (default: all saved chats)"
          : command?.name === "chats"
            ? "Filter and names"
            : "Select chats (choose one)",
        ["allChats", "chatLabel", "chat", "new", "refreshNames"],
      ],
      ["Images", ["images", "refreshMedia"]],
      [
        command?.name === "export"
          ? "Export range and destination"
          : command?.name === "collect"
            ? "History range (optional; default: catch up)"
            : "History range (choose one mode)",
        [
          "last",
          "allHistory",
          "since",
          "from",
          "to",
          ...(command?.name === "export" ? ["out"] : []),
        ],
      ],
      ["Output", ["out", "markdown", "media"]],
      ["Storage and logging", ["db", "log", "backupDir", "backup"]],
      ["Advanced", ["credentials", "pageDelayMin", "pageDelayMax"]],
    ];
    const addOptions = (title: string, names?: string[]) => {
      const options = remaining.filter(
        (option) => !names || names.includes(option.name),
      );
      if (names)
        options.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
      if (!options.length) return;
      sections.push({
        title,
        body: rows(
          options.map((option) => [
            option.rawName,
            `${option.description}${option.config.default !== undefined && typeof option.config.default !== "boolean" ? ` (default: ${option.config.default})` : ""}`,
          ]),
        ),
      });
      for (const option of options)
        remaining.splice(remaining.indexOf(option), 1);
    };
    if (command && examples[command.name])
      for (const [title, names] of groups) addOptions(title, names);
    addOptions("Options");
    return sections;
  });
}
