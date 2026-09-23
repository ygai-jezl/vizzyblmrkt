"use client";

import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import type { ThemePreference } from "@/lib/theme";
import { useAdminTheme } from "./AdminThemeRoot";

const OPTIONS: Array<{ value: ThemePreference; label: string; Icon: LucideIcon }> = [
  { value: "system", label: "Match system", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/**
 * The header's three-way theme switch. Radix handles the group semantics
 * (aria-pressed, roving focus, arrow keys); one of the three is always selected.
 */
export function ThemeSwitch() {
  const theme = useAdminTheme();
  if (!theme) return null;
  return (
    <ToggleGroup.Root
      type="single"
      value={theme.preference}
      // A single ToggleGroup lets the pressed item be clicked off (""); keep a choice.
      onValueChange={(value) => {
        if (value) theme.setPreference(value as ThemePreference);
      }}
      aria-label="Theme"
      className="inline-flex shrink-0 gap-0.5 rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-900"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <ToggleGroup.Item
          key={value}
          value={value}
          aria-label={label}
          title={label}
          className="grid h-6 w-7 place-items-center rounded-md text-neutral-500 outline-none transition-colors hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 data-[state=on]:bg-white data-[state=on]:text-neutral-900 data-[state=on]:shadow-sm dark:text-neutral-400 dark:hover:text-neutral-100 dark:data-[state=on]:bg-neutral-700 dark:data-[state=on]:text-neutral-100"
        >
          <Icon size={14} aria-hidden />
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
