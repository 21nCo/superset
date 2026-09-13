import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { navigateTo } from "./navigation";
import { Pagination } from "./Pagination";

vi.mock("./navigation", () => ({
  navigateTo: vi.fn(),
}));

describe("Pagination", () => {
  it("supports keyboard navigation shortcuts where relevant", async () => {
    render(
      <Pagination
        prevPage={{ title: "Previous Page", path: "/docs/previous" }}
        nextPage={{ title: "Next Page", path: "/docs/next" }}
      />
    );

    expect(screen.getByRole("navigation", { name: "Page navigation" })).toBeTruthy();

    fireEvent.keyDown(window, { altKey: true, key: "ArrowRight" });
    expect(navigateTo).toHaveBeenLastCalledWith("/docs/next");

    fireEvent.keyDown(window, { altKey: true, key: "ArrowLeft" });
    expect(navigateTo).toHaveBeenLastCalledWith("/docs/previous");
  });
});
