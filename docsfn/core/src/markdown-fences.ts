export interface FenceState {
  marker: "`" | "~";
  length: number;
  quoteDepth: number;
  containerIndent: number;
}

export interface FenceLineMatch {
  marker: "`" | "~";
  length: number;
  info: string;
  quoteDepth: number;
}

export function splitBlockQuotePrefix(line: string): {
  quoteDepth: number;
  content: string;
} {
  let quoteDepth = 0;
  let content = line;
  while (true) {
    const match = content.match(/^ {0,3}> ?/);
    if (!match) {
      break;
    }
    quoteDepth += 1;
    content = content.slice(match[0].length);
  }
  return { quoteDepth, content };
}

const LIST_ITEM_MARKER_REGEX = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?: |\t)/;

function stripLeadingContainerIndent(line: string, indent: number): string {
  if (indent <= 0) {
    return line;
  }
  let consumed = 0;
  let index = 0;
  while (index < line.length && consumed < indent) {
    const character = line[index];
    if (character !== " " && character !== "\t") {
      break;
    }
    consumed += 1;
    index += 1;
  }
  return line.slice(index);
}

export function splitMarkdownContainerPrefix(line: string): {
  quoteDepth: number;
  content: string;
  containerIndent: number;
} {
  let quoteDepth = 0;
  let content = line;
  let containerIndent = 0;
  while (true) {
    const quoteMatch = content.match(/^ {0,3}> ?/);
    if (quoteMatch) {
      quoteDepth += 1;
      content = content.slice(quoteMatch[0].length);
      containerIndent += quoteMatch[0].length;
      continue;
    }
    const listMatch = content.match(LIST_ITEM_MARKER_REGEX);
    if (listMatch) {
      content = content.slice(listMatch[0].length);
      containerIndent += listMatch[0].length;
      continue;
    }
    break;
  }
  return { quoteDepth, content, containerIndent };
}

export function matchFenceLine(line: string, containerIndent = 0): FenceLineMatch | null {
  const remaining = stripLeadingContainerIndent(line, containerIndent);
  const { quoteDepth, content } = splitMarkdownContainerPrefix(remaining);
  const match = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }
  const fence = match[1];
  const marker = fence[0] as "`" | "~";
  const info = match[2] ?? "";
  if (marker === "`" && info.includes("`")) {
    return null;
  }
  return { marker, length: fence.length, info, quoteDepth };
}

export function isClosingFence(open: FenceState, candidate: FenceLineMatch): boolean {
  return (
    candidate.marker === open.marker &&
    candidate.length >= open.length &&
    candidate.quoteDepth === open.quoteDepth &&
    /^[ \t]*$/.test(candidate.info)
  );
}

export function scanFenceLines(
  lines: string[],
  onLine: (line: string, inFence: boolean, isFenceLine: boolean) => void
): void {
  let fence: FenceState | null = null;
  let containers: Array<number | "quote"> = [];
  for (const line of lines) {
    let content = line;
    if (fence) {
      for (const container of containers) {
        const match =
          container === "quote"
            ? content.match(/^ {0,3}> ?/)
            : content.match(new RegExp(`^ {${container}}`));
        if (!match) {
          if (content.trim()) fence = null;
          break;
        }
        content = content.slice(match[0].length);
      }
      if (fence) {
        // A list marker inside a code block is literal, never a closing fence.
        const match = content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        const closing = Boolean(
          match &&
            match[1][0] === fence.marker &&
            match[1].length >= fence.length
        );
        onLine(line, true, closing);
        if (closing) fence = null;
        continue;
      }
    }
    containers = [];
    content = line;
    while (true) {
      const quote = content.match(/^ {0,3}> ?/);
      const list = content.match(LIST_ITEM_MARKER_REGEX);
      if (quote) {
        containers.push("quote");
        content = content.slice(quote[0].length);
      } else if (list) {
        containers.push(list[0].length);
        content = content.slice(list[0].length);
      } else break;
    }
    const fenceMatch = matchFenceLine(line);
    if (fenceMatch) {
      fence = {
        ...fenceMatch,
        containerIndent: splitMarkdownContainerPrefix(line).containerIndent,
      };
      onLine(line, true, true);
    } else onLine(line, false, false);
  }
}
