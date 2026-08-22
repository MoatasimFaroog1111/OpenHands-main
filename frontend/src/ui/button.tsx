import { Button as HeroUIButton } from "@heroui/react";
import type { ReactNode } from "react";

export type ButtonAppearance = "default" | "subtle" | "outlined" | "ghost";

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
  appearance?: ButtonAppearance;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  testId?: string;
}

const HERO_UI_VARIANTS = {
  default: "solid",
  subtle: "flat",
  outlined: "bordered",
  ghost: "light",
} as const;

/**
 * Application-level button contract.
 *
 * Feature code should depend on this semantic contract rather than a concrete UI
 * toolkit. The adapter mapping below is the only HeroUI-specific part and can be
 * replaced incrementally as the shared design system converges.
 */
export function Button({
  children,
  onClick,
  type = "button",
  appearance = "default",
  disabled = false,
  className,
  ariaLabel,
  testId,
}: ButtonProps) {
  return (
    <HeroUIButton
      type={type}
      variant={HERO_UI_VARIANTS[appearance]}
      onPress={onClick}
      isDisabled={disabled}
      className={className}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {children}
    </HeroUIButton>
  );
}
