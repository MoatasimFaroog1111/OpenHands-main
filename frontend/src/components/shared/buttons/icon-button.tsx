import React, { ReactElement } from "react";
import { Button } from "#/ui/button";

export interface IconButtonProps {
  icon: ReactElement;
  onClick: () => void;
  ariaLabel: string;
  testId?: string;
}

export function IconButton({
  icon,
  onClick,
  ariaLabel,
  testId = "",
}: IconButtonProps): React.ReactElement {
  return (
    <Button
      type="button"
      appearance="subtle"
      onClick={onClick}
      className="cursor-pointer text-[12px] bg-transparent aspect-square px-0 min-w-[20px] h-[20px]"
      ariaLabel={ariaLabel}
      testId={testId}
    >
      {icon}
    </Button>
  );
}
