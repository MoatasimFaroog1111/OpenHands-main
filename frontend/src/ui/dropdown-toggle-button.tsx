import type { ReactNode } from "react";

export type ToggleButtonPropGetter = (
  props?: Record<string, unknown>,
) => object;

export interface DropdownToggleButtonProps {
  disabled: boolean;
  getToggleButtonProps: ToggleButtonPropGetter;
  children: ReactNode;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}

export function DropdownToggleButton({
  disabled,
  getToggleButtonProps,
  children,
  className,
  testId,
  ariaLabel,
}: DropdownToggleButtonProps) {
  const customProps: Record<string, unknown> = { disabled, className };

  if (testId) {
    customProps["data-testid"] = testId;
  }
  if (ariaLabel) {
    customProps["aria-label"] = ariaLabel;
  }

  const toggleButtonProps = getToggleButtonProps(customProps);

  return (
    <button {...toggleButtonProps} type="button">
      {children}
    </button>
  );
}
