import { ClearButton as SharedClearButton } from "#/ui/clear-button";
import { cn } from "#/utils/utils";

interface ClearButtonProps {
  disabled: boolean;
  onClear: () => void;
  testId?: string;
}

export function ClearButton({
  disabled,
  onClear,
  testId = "dropdown-clear",
}: ClearButtonProps) {
  return (
    <SharedClearButton
      onClear={onClear}
      stopPropagation
      disabled={disabled}
      testId={testId}
      className={cn(
        "p-1 text-[#fff]",
        "cursor-pointer disabled:cursor-not-allowed disabled:opacity-60",
      )}
      icon={
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      }
    />
  );
}
