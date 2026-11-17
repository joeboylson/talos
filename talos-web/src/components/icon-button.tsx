import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type IconButtonProps = Omit<ComponentProps<typeof Button>, "children" | "aria-label"> & {
  label: string;
  icon: ReactNode;
};

// A button that's only an icon. Its name shows on hover and is read out by
// screen readers, so the page needs no words on it.
export const IconButton = ({ label, icon, variant = "ghost", size = "icon", ...buttonProps }: IconButtonProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button variant={variant} size={size} aria-label={label} {...buttonProps}>
        {icon}
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);
