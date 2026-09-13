import { compileMarkdown, type CompileMarkdownInput } from "../markdown";
import type { CompiledContentArtifact } from "../types";

export function compileSvelteContent(
  input: Omit<CompileMarkdownInput, "framework">
): CompiledContentArtifact {
  return compileMarkdown({
    ...input,
    framework: "svelte",
  });
}
