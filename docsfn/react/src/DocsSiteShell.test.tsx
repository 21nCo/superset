import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocsSiteShell } from "./DocsSiteShell";

describe("DocsSiteShell", () => {
  it("renders shared site navigation and footer", () => {
    render(
      <DocsSiteShell
        brand="docsfn"
        items={[{ label: "Docs", href: "/docs" }]}
        footerNote="Built at 21n.co"
        footerLinks={[{ label: "21n.co", href: "https://21n.co", external: true }]}
      >
        <main>Documentation</main>
      </DocsSiteShell>
    );

    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("link", { name: "docsfn" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    expect(screen.getByText("Built at 21n.co")).toBeTruthy();
  });

  it("removes site chrome in embedded mode", () => {
    render(
      <DocsSiteShell embedded brand="docsfn" items={[{ label: "Docs", href: "/docs" }]}>
        <main>Embedded documentation</main>
      </DocsSiteShell>
    );

    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(document.querySelector(".docsfn-site-shell--embedded")).toBeTruthy();
  });

  it("preserves embedded sidebar params when the target already has embed mode", () => {
    window.history.replaceState({}, "", "/docs?embed=1&showSidebar=1");
    render(
      <DocsSiteShell embedded>
        <a href="/blog?embed=1">Blog</a>
      </DocsSiteShell>
    );

    const link = screen.getByRole("link", { name: "Blog" });
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);

    expect(link.getAttribute("href")).toBe("/blog?embed=1&showSidebar=1");
  });
});
