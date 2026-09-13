import React from "react";
import { render } from "@testing-library/react";
import type { Sidebar } from "@docsfn/core";
import { describe, expect, it } from "vitest";
import { DocsSidebar } from "./DocsSidebar";

const sidebar: Sidebar = {
  id: "docs",
  items: [
    {
      type: "group",
      text: "Getting Started",
      items: [{ type: "link", text: "Installation", link: "/docs/installation" }],
    },
    {
      type: "group",
      text: "Core Concepts",
      items: [{ type: "link", text: "Configuration", link: "/docs/configuration" }],
    },
  ],
};

describe("DocsSidebar", () => {
  it("keeps the previous section open when navigation activates another section", () => {
    const view = render(
      <DocsSidebar sidebar={sidebar} activePath="/docs/installation" />
    );

    let groups = Array.from(document.querySelectorAll<HTMLElement>(".docsfn-sidebar-group"));
    expect(groups[0]?.dataset.state).toBe("open");
    expect(groups[1]?.dataset.state).toBe("closed");

    view.rerender(<DocsSidebar sidebar={sidebar} activePath="/docs/configuration" />);

    groups = Array.from(document.querySelectorAll<HTMLElement>(".docsfn-sidebar-group"));
    expect(groups[0]?.dataset.state).toBe("open");
    expect(groups[1]?.dataset.state).toBe("open");
  });
});
