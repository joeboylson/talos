import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEME_CHOICES, type ThemeChoice } from "@/theme";

const THEME_LABELS: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "System" };

// shadcn's dark-mode toggle: the sun and moon swap with the "dark" class.
export const ModeToggle = () => {
  const { themeChoice, setThemeChoice } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8">
          <SunIcon className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <MoonIcon className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
          <span className="sr-only">Change theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={themeChoice} onValueChange={(choice) => setThemeChoice(choice as ThemeChoice)}>
          {THEME_CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice}>
              {THEME_LABELS[choice]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
