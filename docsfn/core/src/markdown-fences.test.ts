import { describe, expect, it } from "vitest";
import { scanFenceLines, splitMarkdownContainerPrefix } from "./markdown-fences";

function scanStates(source: string): Array<{ line: string; inFence: boolean; isFenceLine: boolean }> {
  const states: Array<{ line: string; inFence: boolean; isFenceLine: boolean }> = [];
  scanFenceLines(source.split("\n"), (line, inFence, isFenceLine) => {
    states.push({ line, inFence, isFenceLine });
  });
  return states;
}

describe("markdown fence scanning", () => {
  it("strips nested list and blockquote prefixes before matching a fence", () => {
    expect(splitMarkdownContainerPrefix("- > ```js")).toMatchObject({
      quoteDepth: 1,
      content: "```js",
      containerIndent: 4,
    });
    expect(splitMarkdownContainerPrefix("> - ```js")).toMatchObject({
      quoteDepth: 1,
      content: "```js",
      containerIndent: 4,
    });
  });

  it("closes list-item fences indented four spaces from the document start", () => {
    const states = scanStates(["- ```html", "    <div />", "    ```", "<Tabs />"].join("\n"));
    expect(states.map((state) => [state.line, state.inFence, state.isFenceLine])).toEqual([
      ["- ```html", true, true],
      ["    <div />", true, false],
      ["    ```", true, true],
      ["<Tabs />", false, false],
    ]);
  });

  it("closes fences nested in a list-item blockquote", () => {
    const states = scanStates(["- > ```js", "  > const ok = true;", "  > ```", "<Tabs />"].join("\n"));
    expect(states.at(-1)).toEqual({ line: "<Tabs />", inFence: false, isFenceLine: false });
    expect(states.filter((state) => state.isFenceLine).map((state) => state.line)).toEqual([
      "- > ```js",
      "  > ```",
    ]);
  });

  it("does not treat a four-space indented fence as an opener", () => {
    const states = scanStates(["    ```", "    still indented", "    ```", "outside"].join("\n"));
    expect(states.every((state) => !state.inFence && !state.isFenceLine)).toBe(true);
  });
});

it("does not end a root fence on a literal list marker", () => {
  const states = scanStates(["```", "- ```", "<Tabs>", "```", "after"].join("\n"));
  expect(states[1].isFenceLine).toBe(false);
  expect(states[2].inFence).toBe(true);
  expect(states[4].inFence).toBe(false);
});
it("ends an unclosed fence when its list or quote container ends", () => {
  for (const opener of ["- ```", "> ```"]) {
    expect(scanStates([opener, "outside"].join("\n"))[1].inFence).toBe(false);
  }
});
it("distinguishes quote-inside-list from list-inside-quote", () => {
  const states = scanStates(["- > ```", "> - text"].join("\n"));
  expect(states[1].inFence).toBe(false);
});
