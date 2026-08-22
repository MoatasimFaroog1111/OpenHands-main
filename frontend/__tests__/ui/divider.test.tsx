import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Divider } from "#/ui/divider";

describe("Divider", () => {
  it("preserves the legacy horizontal default", () => {
    render(<Divider testId="divider" />);

    const divider = screen.getByTestId("divider");
    expect(divider).toHaveAttribute("role", "separator");
    expect(divider).toHaveAttribute("aria-orientation", "horizontal");
    expect(divider).toHaveClass("w-full", "h-[1px]", "bg-[#5C5D62]");
  });

  it("supports the shared design-system type contract", () => {
    render(<Divider type="vertical" testId="divider" />);

    const divider = screen.getByTestId("divider");
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
    expect(divider).toHaveClass("h-full", "w-[1px]");
  });

  it("keeps the legacy orientation prop working", () => {
    render(<Divider orientation="vertical" testId="divider" />);

    expect(screen.getByTestId("divider")).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );
  });

  it("prefers the new type contract when both props are supplied", () => {
    render(
      <Divider
        type="vertical"
        orientation="horizontal"
        testId="divider"
        className="custom-divider"
        data-state="ready"
      />,
    );

    const divider = screen.getByTestId("divider");
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
    expect(divider).toHaveAttribute("data-state", "ready");
    expect(divider).toHaveClass("custom-divider");
  });
});
