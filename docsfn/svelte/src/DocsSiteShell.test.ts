import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import DocsSiteShell from "./DocsSiteShell.svelte";

afterEach(() => {
  cleanup();
});

describe("DocsSiteShell", () => {
  it("renders shared site navigation and footer", () => {
    render(DocsSiteShell, {
      brand: "docsfn",
      items: [{ label: "Docs", href: "/docs" }],
      footerNote: "Built at 21n.co",
      footerLinks: [{ label: "21n.co", href: "https://21n.co", external: true }],
    });

    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("link", { name: "docsfn" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    expect(screen.getByText("Built at 21n.co")).toBeTruthy();
  });

  it("removes site chrome in embedded mode", () => {
    render(DocsSiteShell, {
      embedded: true,
      brand: "docsfn",
      items: [{ label: "Docs", href: "/docs" }],
    });

    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(document.querySelector(".docsfn-site-shell--embedded")).toBeTruthy();
  });
});
