import type { ButtonHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

interface HeroButtonMockProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  onPress?: () => void;
  isDisabled?: boolean;
  variant?: string;
}

vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
    variant,
    ...props
  }: HeroButtonMockProps) => (
    <button
      {...props}
      data-variant={variant}
      disabled={isDisabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
}));

import { IconButton } from "#/components/shared/buttons/icon-button";
import { Button } from "#/ui/button";

describe("application Button contract", () => {
  it("maps semantic appearance to the current UI adapter", () => {
    render(
      <Button appearance="subtle" ariaLabel="Open menu" testId="menu-button">
        Menu
      </Button>,
    );

    const button = screen.getByTestId("menu-button");
    expect(button).toHaveAttribute("data-variant", "flat");
    expect(button).toHaveAttribute("aria-label", "Open menu");
  });

  it("uses native-style click and disabled semantics", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Run</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        Run
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps IconButton behavior while removing its direct toolkit dependency", () => {
    const onClick = vi.fn();
    render(
      <IconButton
        icon={<span>+</span>}
        onClick={onClick}
        ariaLabel="Add item"
        testId="add-item"
      />,
    );

    const button = screen.getByTestId("add-item");
    expect(button).toHaveAttribute("data-variant", "flat");
    expect(button).toHaveAttribute("aria-label", "Add item");

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
