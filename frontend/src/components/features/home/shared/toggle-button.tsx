import ChevronDownSmallIcon from "#/icons/chevron-down-small.svg?react";
import { DropdownToggleButton } from "#/ui/dropdown-toggle-button";
import { cn } from "#/utils/utils";

interface ToggleButtonProps {
  isOpen: boolean;
  disabled: boolean;
  getToggleButtonProps: (
    props?: Record<string, unknown>,
  ) => Record<string, unknown>;
  iconClassName?: string;
}

export function ToggleButton({
  isOpen,
  disabled,
  getToggleButtonProps,
  iconClassName,
}: ToggleButtonProps) {
  return (
    <DropdownToggleButton
      disabled={disabled}
      getToggleButtonProps={getToggleButtonProps}
      ariaLabel="Toggle menu"
      className={cn(
        "text-[#fff]",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      <ChevronDownSmallIcon
        className={cn(
          "w-4 h-4 transition-transform",
          isOpen && "rotate-180",
          iconClassName,
        )}
      />
    </DropdownToggleButton>
  );
}
