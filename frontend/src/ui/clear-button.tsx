import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import { X } from "lucide-react";

export interface ClearButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children" | "onClick" | "type"
> {
  onClear: () => void;
  stopPropagation?: boolean;
  testId?: string;
  ariaLabel?: string;
  icon?: ReactNode;
}

export function ClearButton({
  onClear,
  stopPropagation = false,
  testId = "dropdown-clear",
  ariaLabel = "Clear selection",
  icon = <X size={14} />,
  ...buttonProps
}: ClearButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
    onClear();
  };

  return (
    <button
      {...buttonProps}
      type="button"
      onClick={handleClick}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {icon}
    </button>
  );
}
