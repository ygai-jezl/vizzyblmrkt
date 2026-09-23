"use client";

import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronsUpDown, LogOut, Settings } from "lucide-react";
import { useSignOut } from "../LogoutButton";
import { useThemePortalContainer } from "./AdminThemeRoot";

const ITEM =
  "flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-neutral-700 outline-none data-[highlighted]:bg-neutral-100 data-[highlighted]:text-neutral-900 dark:text-neutral-300 dark:data-[highlighted]:bg-neutral-800 dark:data-[highlighted]:text-neutral-100";

function initials(email: string | undefined): string {
  const local = email?.split("@")[0]?.replace(/[^a-zA-Z]/g, "") ?? "";
  return (local.slice(0, 2) || "?").toUpperCase();
}

/**
 * The sidebar footer: who is signed in, with Settings and Sign out. Replaces the
 * raw `tenantId · region · role` line; those ids stay one click away in the menu.
 */
export function ProfileMenu({
  email,
  role,
  tenantId,
  region,
  collapsed,
}: {
  email?: string;
  role: string;
  tenantId: string;
  region: string;
  collapsed: boolean;
}) {
  const signOut = useSignOut();
  const container = useThemePortalContainer();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="Account menu"
        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-blue-500 data-[state=open]:bg-neutral-100 dark:hover:bg-neutral-800 dark:data-[state=open]:bg-neutral-800 ${
          collapsed ? "justify-center" : ""
        }`}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-200 text-[11px] font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          {initials(email)}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {email ?? "Signed in"}
              </span>
              <span className="block text-xs capitalize text-neutral-500 dark:text-neutral-400">{role}</span>
            </span>
            <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-neutral-400" />
          </>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 min-w-[232px] rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="px-2.5 py-2">
            <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">{email ?? "Signed in"}</p>
            <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
              <span className="capitalize">{role}</span> · {tenantId} · {region}
            </p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
          <DropdownMenu.Item asChild className={ITEM}>
            <Link href="/admin/account">
              <Settings size={15} aria-hidden />
              Settings
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} onSelect={() => void signOut()}>
            <LogOut size={15} aria-hidden />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
