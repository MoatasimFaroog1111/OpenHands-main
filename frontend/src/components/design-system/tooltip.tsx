import { Tooltip as HeroUITooltip } from "@heroui/react";
import type { ReactElement, ReactNode } from "react";

export interface TooltipProps {
  children: ReactElement;
  content: ReactNode;
  hideDelayMs?: number;
  className?: string;
}

/**
 * App-facing tooltip contract that hides the concrete UI implementation.
 */
export function Tooltip({
  children,
  content,
  hideDelayMs = 0,
  className,
}: TooltipProps) {
  return (
    <HeroUITooltip
      content={content}
      closeDelay={hideDelayMs}
      className={className}
    >
      {children}
    </HeroUITooltip>
  );
}
