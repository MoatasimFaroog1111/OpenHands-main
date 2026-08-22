import { ChevronDown } from "lucide-react";
import { DropdownToggleButton } from "#/ui/dropdown-toggle-button";
import { cn } from "#/utils/utils";

interface ToggleButtonProps {
  isOpen: boolean;
  isDisabled: boolean;
  getToggleButtonProps: (props?: object) => object;
}

export function ToggleButton({
  isOpen,
  isDisabled,
  getToggleButtonProps,
}: ToggleButtonProps) {
  return (
    <DropdownToggleButton
      disabled={isDisabled}
      getToggleButtonProps={getToggleButtonProps}
      testId="dropdown-trigger"
      className={cn("text-white", isDisabled && "cursor-not-allowed")}
    >
      <ChevronDown
        size={16}
        className={cn("transition-transform", isOpen && "rotate-180")}
      />
    </DropdownToggleButton>
  );
}
