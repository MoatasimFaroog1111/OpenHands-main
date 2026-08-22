import { ClearButton as SharedClearButton } from "#/ui/clear-button";

interface ClearButtonProps {
  onClear: () => void;
}

export function ClearButton({ onClear }: ClearButtonProps) {
  return (
    <SharedClearButton
      onClear={onClear}
      className="text-white hover:text-gray-300"
    />
  );
}
