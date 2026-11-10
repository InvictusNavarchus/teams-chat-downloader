// Shared application defaults and command limits. Resolve environment-dependent
// paths at invocation time in the credential and media helpers.
export const defaultPageDelay = { min: 2, max: 5 } as const;
export const pageDelayLimits = { min: 0, max: 3600 } as const;
export const loginTimeout = { default: 600, min: 1, max: 3600 } as const;
export const defaultExportRoot = "exports";
export const defaultOutputFormat = "markdown";
export const commandDefaults = {
  markdown: true,
  media: true,
  refreshMedia: false,
  recursive: false,
  waitForMedia: false,
} as const;
