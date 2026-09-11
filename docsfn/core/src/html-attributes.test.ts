import { expect, it } from "vitest";
import { mapHtmlAttributes } from "./html-attributes";

it("preserves attribute boundaries after removing boolean and slash-prefixed handlers", () => {
  const removeEvents = (name: string, _value: string, raw: string) => name.startsWith("on") ? "" : raw;
  expect(mapHtmlAttributes('<a onload href="/safe" title=">">text /onload=x</a>', removeEvents)).toBe('<a href="/safe" title=">">text /onload=x</a>');
  expect(mapHtmlAttributes('<svg/onload=alert(1)>', removeEvents)).toBe('<svg>');
});
it("scans repeated unmatched tag prefixes without changing them", () => {
  const text = "<a".repeat(50_000);
  expect(mapHtmlAttributes(text, (_name, _value, raw) => raw)).toBe(text);
});
