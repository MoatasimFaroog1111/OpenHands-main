import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "#/utils/utils";

const dividerVariants = cva("", {
  variants: {
    orientation: {
      horizontal: "w-full h-[1px]",
      vertical: "h-full w-[1px]",
    },
    color: {
      light: "bg-[#5C5D62]",
    },
    size: {
      thin: "",
    },
  },
  defaultVariants: {
    orientation: "horizontal",
    color: "light",
    size: "thin",
  },
});

type DividerOrientation = NonNullable<
  VariantProps<typeof dividerVariants>["orientation"]
>;

type DividerProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "color" | "aria-orientation"
> &
  Omit<VariantProps<typeof dividerVariants>, "orientation"> & {
    /**
     * Preferred design-system contract. Matches @openhands/ui Divider.
     */
    type?: DividerOrientation;
    /**
     * Backwards-compatible frontend prop. Prefer `type` for new call sites.
     */
    orientation?: DividerOrientation;
    testId?: string;
  };

export function Divider({
  type,
  orientation,
  color,
  size,
  className,
  testId,
  ...props
}: DividerProps) {
  const resolvedOrientation = type ?? orientation ?? "horizontal";

  return (
    <div
      {...props}
      role="separator"
      aria-orientation={resolvedOrientation}
      data-testid={testId}
      className={cn(
        dividerVariants({
          orientation: resolvedOrientation,
          color,
          size,
        }),
        className,
      )}
    />
  );
}
