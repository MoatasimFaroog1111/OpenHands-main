import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClearButton } from "#/ui/clear-button";

describe("ClearButton", () => {
  it("uses the accessible default contract and calls onClear", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();

    render(<ClearButton onClear={onClear} />);

    const button = screen.getByTestId("dropdown-clear");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("aria-label", "Clear selection");

    await user.click(button);

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("optionally stops click propagation", async () => {
    const user = userEvent.setup();
    const parentClick = vi.fn();
    const onClear = vi.fn();

    render(
      <div onClick={parentClick}>
        <ClearButton onClear={onClear} stopPropagation />
      </div>,
    );

    await user.click(screen.getByTestId("dropdown-clear"));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("respects the native disabled behavior", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();

    render(<ClearButton onClear={onClear} disabled />);

    const button = screen.getByTestId("dropdown-clear");
    expect(button).toBeDisabled();

    await user.click(button);

    expect(onClear).not.toHaveBeenCalled();
  });

  it("forwards custom presentation and native attributes", () => {
    render(
      <ClearButton
        onClear={() => undefined}
        testId="custom-clear"
        ariaLabel="Remove selected repository"
        className="custom-clear"
        data-state="ready"
        icon={<span data-testid="custom-icon">×</span>}
      />,
    );

    const button = screen.getByTestId("custom-clear");
    expect(button).toHaveAttribute("aria-label", "Remove selected repository");
    expect(button).toHaveAttribute("data-state", "ready");
    expect(button).toHaveClass("custom-clear");
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
  });
});
