import { Button as HeroUIButton } from "@heroui/react";
import type { ReactNode } from "react";

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
  testId?: string;
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  appearance?: "solid" | "flat";
}

/**
 * App-facing button contract.
 *
 * Feature/shared code should depend on this contract instead of a concrete UI
 * library. HeroUI remains the implementation during the incremental migration;
 * the adapter can later move to @openhands/ui without changing consumers.
 */
export function Button({
  children,
  onClick,
  ariaLabel,
  testId,
  className,
  disabled = false,
  type = "button",
  appearance = "solid",
}: ButtonProps) {
  return (
    <HeroUIButton
      type={type}
      variant={appearance}
      onPress={onClick}
      aria-label={ariaLabel}
      data-testid={testId}
      className={className}
      isDisabled={disabled}
    >
      {children}
    </HeroUIButton>
  );
}
