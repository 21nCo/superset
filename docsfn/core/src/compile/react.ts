import { compileMarkdown, type CompileMarkdownInput } from "../markdown";
import type { CompiledContentArtifact } from "../types";

export function compileReactContent(
  input: Omit<CompileMarkdownInput, "framework">
): CompiledContentArtifact {
  return compileMarkdown({
    ...input,
    framework: "react",
  });
}
