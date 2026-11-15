// Teams marks standard emoji explicitly; ordinary image alt text is not emoji.
export function teamsEmojiText(element: {
  getAttribute(name: string): string | null;
}): string | undefined {
  if (element.getAttribute("itemtype") !== "http://schema.skype.com/Emoji")
    return;
  return element.getAttribute("alt")?.trim() || undefined;
}
