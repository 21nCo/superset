import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
// vi.waitFor used below for async visual editor mount (dynamic import); fixed delays flake on GHA.
import { render } from "solid-js/web";
import { createEditor, Transaction } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { MdfnAuthoringChrome, MdfnEditorShell } from "./index";

describe("Solid authoring components", () => {
  it("mounts UIFn chrome and every read-only authoring surface", async () => {
    const controller = createEditor({ markdown: "# Outline", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    const dispose = render(() => <MdfnEditorShell controller={controller} mode="read-only" />, target);
    await Promise.resolve();
    expect(target.querySelector('[data-mdfn-component="authoring-chrome"]')).not.toBeNull();
    expect(target.querySelector('[data-mdfn-surface="outline"]')?.textContent).toContain("Outline");
    expect(target.querySelector('[data-uifn-component="card"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="Select files"]')).toBeNull();
    expect(Array.from(target.querySelectorAll("button")).some((button) => button.textContent === "Add comment")).toBe(false);
    dispose();
    expect(target.children).toHaveLength(0);
  });

  it("keeps shell-only properties off the editor DOM", async () => {
    const controller = createEditor({ markdown: "# Props", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    const dispose = render(() => <MdfnEditorShell controller={controller} mode="read-only" readOnly class="shell-class" actor={{ id: "author" }} onModeChange={() => {}} onSelectFiles={async () => undefined} />, target);
    await Promise.resolve();
    const shell = target.querySelector('[data-mdfn-component="editor-shell"]');
    const editor = target.querySelector('[data-mdfn-solid="editor"]');
    expect(shell?.classList.contains("shell-class")).toBe(true);
    expect(editor?.hasAttribute("actor")).toBe(false);
    expect(editor?.hasAttribute("onModeChange")).toBe(false);
    expect(editor?.hasAttribute("onSelectFiles")).toBe(false);
    dispose();
  });

  it("keeps toolbar parts mounted when the editor and document become reactive", async () => {
    const controller = createEditor({ markdown: "# Reactive", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    const dispose = render(() => <MdfnEditorShell controller={controller} mode="visual" />, target);
    await vi.waitFor(() => {
      expect(target.querySelector('[data-mdfn-source-fallback="true"]')).toBeNull();
      expect(target.querySelector('[data-mdfn-editor="visual"]')).not.toBeNull();
    });
    controller.dispatch(new Transaction().replaceSource(0, 0, "Updated "));
    await Promise.resolve();
    expect(target.querySelector('[data-mdfn-source-fallback="true"]')).toBeNull();
    expect(target.querySelector('[data-mdfn-editor="visual"]')).not.toBeNull();
    dispose();
  });

  it("runs contextual editorial and version workflows", async () => {
    const controller = createEditor({ markdown: "text", projector: createMarkdownProjector(), selection: { kind: "text", anchor: 0, head: 4 } });
    const restore = vi.fn();
    const target = document.createElement("div");
    const dispose = render(() => <MdfnAuthoringChrome controller={controller} versions={[{ version: 1 }]} onRestoreVersion={restore} />, target);
    await Promise.resolve();
    expect(target.querySelector('[data-mdfn-surface="bubble-toolbar"]')).not.toBeNull();
    expect(target.querySelector('[data-mdfn-surface="floating-toolbar"]')).toBeNull();
    const update = async (label: string, value: string): Promise<void> => {
      const input = target.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      input.value = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      await Promise.resolve();
    };
    const button = (label: string): HTMLButtonElement => Array.from(target.querySelectorAll("button")).find((candidate) => candidate.textContent === label) as HTMLButtonElement;
    await update("Comment", "Review this");
    button("Add comment").click();
    await Promise.resolve();
    const thread = controller.getState().sidecar?.comments?.[0];
    await update(`Reply to comment ${thread!.id}`, "Reply");
    button("Reply").click();
    await Promise.resolve();
    button("Resolve").click();
    await Promise.resolve();
    expect(controller.getState().sidecar?.comments?.[0]).toMatchObject({ resolved: true, messages: expect.arrayContaining([expect.objectContaining({ body: "Reply" })]) });
    await update("Suggestion replacement", "replacement");
    button("Add suggestion").click();
    await Promise.resolve();
    expect(controller.getState().sidecar?.suggestions?.[0]?.replacement).toBe("replacement");
    button("Restore").click();
    expect(restore).toHaveBeenCalledWith(1);
    dispose();
  });

  it("inserts selected-file Markdown in source mode without a visual editor", async () => {
    const controller = createEditor({
      markdown: "before",
      projector: createMarkdownProjector(),
      selection: { kind: "text", anchor: 6, head: 6 },
    });
    const target = document.createElement("div");
    const dispose = render(() => <MdfnAuthoringChrome controller={controller} mode="source" onSelectFiles={async () => "![asset](mdfn-asset:filefn/id)"} />, target);
    await Promise.resolve();
    const input = target.querySelector<HTMLInputElement>('[aria-label="Select files"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "x.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    expect(controller.getState().markdown).toBe("before![asset](mdfn-asset:filefn/id)");
    dispose();
  });

  it("anchors a pending file insertion to the original selection", async () => {
    const controller = createEditor({ markdown: "before after", projector: createMarkdownProjector(), selection: { kind: "text", anchor: 7, head: 12 } });
    let resolveUpload!: (markdown: string) => void;
    const target = document.createElement("div");
    const dispose = render(() => <MdfnAuthoringChrome controller={controller} mode="source" onSelectFiles={() => new Promise((resolve) => { resolveUpload = resolve; })} />, target);
    await Promise.resolve();
    const input = target.querySelector<HTMLInputElement>('[aria-label="Select files"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "x.png")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    controller.dispatch(new Transaction().replaceSource(0, 0, "prefix ").setSelection({ kind: "text", anchor: 0, head: 0 }));
    resolveUpload("asset");
    await Promise.resolve();
    expect(controller.getState().markdown).toBe("prefix before asset");
    dispose();
  });

  it("follows a replacement controller in the authoring chrome", async () => {
    const first = createEditor({ markdown: "# First", projector: createMarkdownProjector() });
    const second = createEditor({ markdown: "# Second", projector: createMarkdownProjector() });
    const [controller, setController] = createSignal(first);
    const target = document.createElement("div");
    const dispose = render(() => <MdfnAuthoringChrome controller={controller()} mode="read-only" />, target);
    await Promise.resolve();
    expect(target.querySelector('[data-mdfn-surface="outline"]')?.textContent).toContain("First");

    setController(second);
    await Promise.resolve();
    expect(target.querySelector('[data-mdfn-surface="outline"]')?.textContent).toContain("Second");
    first.dispatch(new Transaction().replaceSource(2, 7, "Detached"));
    second.dispatch(new Transaction().replaceSource(2, 8, "Active"));
    await Promise.resolve();
    expect(target.querySelector('[data-mdfn-surface="outline"]')?.textContent).toContain("Active");
    expect(target.querySelector('[data-mdfn-surface="outline"]')?.textContent).not.toContain("Detached");
    dispose();
  });
});
