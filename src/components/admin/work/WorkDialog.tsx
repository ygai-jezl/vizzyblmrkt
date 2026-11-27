"use client";

import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useThemePortalContainer } from "@/components/admin/nav/AdminThemeRoot";

/** A dialog over a Work screen, inside the admin theme root so the Light or Dark choice applies. */
export function WorkDialog({ open, onClose, title, about, children, footer, wide = false }: { open: boolean; onClose: () => void; title: string; about: ReactNode; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  const container = useThemePortalContainer();
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className={`fixed inset-x-4 top-[6vh] z-50 mx-auto flex max-h-[88vh] flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-neutral-950 ${wide ? "max-w-4xl" : "max-w-xl"}`}>
          <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
            <div>
              <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">{about}</Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900">
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="space-y-4 overflow-y-auto px-5 py-4 text-sm">{children}</div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
