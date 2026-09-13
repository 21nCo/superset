import { createDiagnostic, createDocsError } from "../diagnostics";
import { scanFenceLines } from "../markdown-fences";

const SUPPORTED_FUMADOCS_IMPORTS: Record<string, Set<string>> = {
  "fumadocs-ui/components/tabs": new Set(["Tabs", "Tab"]),
};

export interface FumadocsTransformInput {
  source: string;
  sourcePath?: string;
}

export interface FumadocsTransformResult {
  transformed: string;
  importedComponents: Set<string>;
  componentsUsed: string[];
}

interface ImportSpecifier {
  imported: string;
  local: string;
}

function parseImportSpecifiers(source: string): ImportSpecifier[] {
  return source
    .split(",")
    .map((entry) => {
      const words = entry.trim().split(/\s+/);
      const alias = words.indexOf("as");
      const imported = words.slice(0, alias === -1 ? words.length : alias).join(" ");
      const local = alias === -1 ? imported : words.slice(alias + 1).join(" ");
      return { imported, local };
    })
    .filter((specifier) => specifier.imported.length > 0 && specifier.local.length > 0);
}

function parseNamedImport(line: string): { rawSpecifiers: string; moduleName: string } | null {
  const trimmed = line.trim().replace(/;$/, "").trimEnd();
  if (!trimmed.startsWith("import")) return null;
  const open = trimmed.indexOf("{");
  const close = trimmed.indexOf("}", open + 1);
  if (open === -1 || close === -1 || trimmed.slice(6, open).trim() !== "") return null;
  const from = trimmed.slice(close + 1).trim();
  if (!from.startsWith("from")) return null;
  const quoted = from.slice(4).trim();
  const quote = quoted[0];
  if ((quote !== '"' && quote !== "'") || quoted.at(-1) !== quote) return null;
  return { rawSpecifiers: trimmed.slice(open + 1, close), moduleName: quoted.slice(1, -1) };
}

function validateFumadocsImport(input: {
  sourcePath?: string;
  moduleName: string;
  specifier: string;
}): void {
  const supported = SUPPORTED_FUMADOCS_IMPORTS[input.moduleName];
  if (supported && supported.has(input.specifier)) {
    return;
  }

  throw createDocsError({
    code: "DOCS_COMPAT_UNSUPPORTED",
    message: `unsupported compatibility construct ${input.specifier} from ${input.moduleName}`,
    diagnostics: [
      createDiagnostic({
        code: "DOCS_COMPAT_UNSUPPORTED",
        message: `unsupported compatibility construct ${input.specifier} from ${input.moduleName}`,
        location: {
          absolutePath: input.sourcePath,
        },
        details: {
          component: input.specifier,
          module: input.moduleName,
        },
      }),
    ],
  });
}

function rewriteTag(source: string, local: string, canonical: "DocsTabs" | "DocsTab"): string {
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source
    .replace(new RegExp(`<\\s*${escaped}(?=[\\s>])`, "g"), `<${canonical}`)
    .replace(new RegExp(`<\\s*\\/\\s*${escaped}\\s*>`, "g"), `</${canonical}>`);
}

function rewriteTagsInText(
  source: string,
  aliases: Map<string, "DocsTabs" | "DocsTab">
): string {
  let rewritten = source;
  for (const [local, canonical] of aliases) {
    rewritten = rewriteTag(rewritten, local, canonical);
  }
  return rewritten;
}

function rewriteOutsideInlineCode(
  source: string,
  aliases: Map<string, "DocsTabs" | "DocsTab">
): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] !== "`") {
      const next = source.indexOf("`", index);
      const chunk = next === -1 ? source.slice(index) : source.slice(index, next);
      result += rewriteTagsInText(chunk, aliases);
      if (next === -1) {
        break;
      }
      index = next;
      continue;
    }
    let length = 1;
    while (index + length < source.length && source[index + length] === "`") {
      length += 1;
    }
    let cursor = index + length;
    let closer = -1;
    while (cursor < source.length) {
      if (source[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let run = 0;
      while (cursor + run < source.length && source[cursor + run] === "`") {
        run += 1;
      }
      if (run === length) {
        closer = cursor + run;
        break;
      }
      cursor += run;
    }
    if (closer === -1) {
      result += rewriteTagsInText(source.slice(index), aliases);
      break;
    }
    result += source.slice(index, closer);
    index = closer;
  }
  return result;
}

export function transformFumadocsV15(
  input: FumadocsTransformInput
): FumadocsTransformResult {
  const lines = input.source.split(/\r?\n/);
  const keptLines: string[] = [];
  const importedComponents = new Set<string>();
  const aliases = new Map<string, "DocsTabs" | "DocsTab">();

  scanFenceLines(lines, (line, inFence) => {
    if (inFence) {
      keptLines.push(line);
      return;
    }

    const importMatch = parseNamedImport(line);
    if (!importMatch) {
      keptLines.push(line);
      return;
    }

    const { rawSpecifiers, moduleName } = importMatch;
    const specifiers = parseImportSpecifiers(rawSpecifiers);
    for (const specifier of specifiers) {
      importedComponents.add(specifier.local);
      if (moduleName.startsWith("fumadocs")) {
        validateFumadocsImport({
          sourcePath: input.sourcePath,
          moduleName,
          specifier: specifier.imported,
        });
        aliases.set(
          specifier.local,
          specifier.imported === "Tabs" ? "DocsTabs" : "DocsTab"
        );
      }
    }
  });

  const rewrittenChunks: string[] = [];
  let pending: string[] = [];
  const flushPending = () => {
    if (pending.length === 0) {
      return;
    }
    rewrittenChunks.push(rewriteOutsideInlineCode(pending.join("\n"), aliases));
    pending = [];
  };

  scanFenceLines(keptLines, (line, inFence, isFenceLine) => {
    if (inFence && isFenceLine) {
      flushPending();
      rewrittenChunks.push(line);
      return;
    }
    if (inFence) {
      flushPending();
      rewrittenChunks.push(line);
      return;
    }
    pending.push(line);
  });
  flushPending();

  const transformed = rewrittenChunks.join("\n");
  const componentsUsed: string[] = [];

  if (/<\s*DocsTabs(?=[\s>])/.test(transformed)) {
    componentsUsed.push("DocsTabs");
  }
  if (/<\s*DocsTab(?=[\s>])/.test(transformed)) {
    componentsUsed.push("DocsTab");
  }
  if (/```mermaid/.test(transformed)) {
    componentsUsed.push("MermaidBlock");
  }

  return {
    transformed,
    importedComponents,
    componentsUsed,
  };
}
