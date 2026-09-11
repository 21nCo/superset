import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import DocsToc from "./DocsToc.svelte";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.querySelectorAll("h2").forEach((node) => node.remove()); });

it("reconnects heading observation after client navigation and respects controlled hashes", async () => {
  const observed: string[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    observe(element: Element) { observed.push(element.id); }
    disconnect = disconnect;
  });
  for (const id of ["first", "second"]) {
    const heading = document.createElement("h2"); heading.id = id; document.body.append(heading);
  }
  const heading = (slug: string) => ({ slug, text: slug, level: 2 });
  const view = render(DocsToc, { headings: [heading("first")] });
  await waitFor(() => expect(observed).toContain("first"));
  await view.rerender({ headings: [heading("second")] });
  await waitFor(() => expect(observed).toContain("second"));
  expect(disconnect).toHaveBeenCalled();
  await view.rerender({ headings: [heading("second")], activeHash: "#second" });
  expect(screen.getByRole("link", { name: "second" }).getAttribute("aria-current")).toBe("location");
});
