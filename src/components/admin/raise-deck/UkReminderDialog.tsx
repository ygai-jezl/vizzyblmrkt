"use client";

import { Modal } from "@/components/admin/email/Modal";
import { showsUkReminder } from "@/lib/raise/docs/edit";
import type { DeckAudience } from "@/lib/raise/docs/types";
import { PDF_WORDS, UK_PROMOTION_REMINDER } from "@/lib/raise/docs/words";

/** What the dialog says before the print window: the UK reminder (investor decks only), the Needs that won't print, and how to save. Pure. */
export function beforeSaveLines(audience: DeckAudience, needs: number): string[] {
  return [...(showsUkReminder(audience) ? [UK_PROMOTION_REMINDER] : []), ...(needs > 0 ? [PDF_WORDS.needs(needs)] : []), PDF_WORDS.print];
}

/**
 * Before you save: for an investor deck, the reminder that sending it to invite investment is a
 * financial promotion in the UK. A lender pack has no reminder (a loan isn't an investment), so it
 * shows only the Needs and print lines.
 */
export function UkReminderDialog({ open, audience, needs, onSave, onCancel }: { open: boolean; audience: DeckAudience; needs: number; onSave: () => void; onCancel: () => void }) {
  const lines = beforeSaveLines(audience, needs);
  return (
    <Modal open={open} onClose={onCancel} title={PDF_WORDS.title}>
      <div className="space-y-3 text-sm">
        {lines.map((line) => (
          <p key={line} className={line === UK_PROMOTION_REMINDER ? "rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100" : undefined}>
            {line}
          </p>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
            {PDF_WORDS.cancel}
          </button>
          <button type="button" onClick={onSave} className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white dark:border-white dark:bg-white dark:text-neutral-900">
            {PDF_WORDS.save}
          </button>
        </div>
      </div>
    </Modal>
  );
}
