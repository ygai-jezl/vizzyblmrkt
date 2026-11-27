"use client";

import { useState } from "react";
import { RAISE_AREAS, reasonsInArea, type RaiseArea, type RaiseAudience } from "@/lib/raise/reasons";
import { PASS_WORDS } from "@/lib/raise/pipeline/words";
import { Button } from "../connect/ui";
import { Modal } from "../email/Modal";
import type { ReasonChoice } from "./investorsApi";

/**
 * "Why did they pass?" (RAISE_PIPELINE_ENABLED): shown when a card is moved onto Passed and the
 * brand has a Pass reason field. Seven area chips; tapping one shows its reasons as chips, and one
 * can be picked. On a Funding board the lender and grant reasons come first under Deal and Fit. The
 * team's own reasons sit under Other. Save moves with the reason, Leave it blank moves with none,
 * Cancel doesn't move.
 */

/** Who a Funding board's reasons usually come from, first within their area. */
const FUNDING_FIRST: readonly RaiseAudience[] = ["lender", "grant"];

/**
 * The reasons under one area chip, from the brand's own Pass reason options: the fixed keys in
 * their order (lender and grant first on a Funding board), then, under Other, the team's own. A key
 * the brand doesn't hold (an archived option) isn't offered. Pure.
 */
export function reasonChips(options: readonly ReasonChoice[], area: RaiseArea, funding: boolean): ReasonChoice[] {
  const byKey = new Map(options.filter((o) => o.key).map((o) => [o.key!, o]));
  const keyed = reasonsInArea(area, funding ? FUNDING_FIRST : []).flatMap((r) => {
    const o = byKey.get(r.key);
    return o ? [o] : [];
  });
  return area === "other" ? [...keyed, ...options.filter((o) => !o.key)] : keyed;
}

/** The area chips that have a reason to pick, in their order. Pure. */
export function areasWithReasons(options: readonly ReasonChoice[], funding: boolean): Array<{ key: RaiseArea; label: string }> {
  return RAISE_AREAS.filter((a) => reasonChips(options, a.key, funding).length > 0);
}

const chip = (on: boolean) =>
  `rounded-full border px-3 py-1 text-sm ${
    on
      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
      : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

export function PassReasonDialog({
  options,
  funding,
  onSave,
  onCancel,
  initialArea = null,
}: {
  options: readonly ReasonChoice[];
  funding: boolean;
  /** The reason picked (an option id), or null for Leave it blank. */
  onSave: (reason: string | null) => void;
  onCancel: () => void;
  initialArea?: RaiseArea | null;
}) {
  const [area, setArea] = useState<RaiseArea | null>(initialArea);
  const [picked, setPicked] = useState<string | null>(null);
  const areas = areasWithReasons(options, funding);
  const chips = area ? reasonChips(options, area, funding) : [];
  const own = area === "other" ? chips.filter((o) => !o.key) : [];
  const keyed = area === "other" ? chips.filter((o) => o.key) : chips;

  const reasonChip = (o: ReasonChoice) => (
    <button key={o.optionId} type="button" aria-pressed={picked === o.optionId} className={chip(picked === o.optionId)} onClick={() => setPicked(picked === o.optionId ? null : o.optionId)}>
      {o.label}
    </button>
  );

  return (
    <Modal open onClose={onCancel} title={PASS_WORDS.title}>
      <div className="space-y-4 text-sm">
        <p className="text-neutral-600 dark:text-neutral-400">{PASS_WORDS.line}</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label={PASS_WORDS.title}>
          {areas.map((a) => (
            <button key={a.key} type="button" aria-pressed={area === a.key} className={chip(area === a.key)} onClick={() => setArea(area === a.key ? null : a.key)}>
              {a.label}
            </button>
          ))}
        </div>
        {area ? (
          <div className="space-y-3 rounded-md bg-neutral-50 p-3 dark:bg-neutral-900">
            {keyed.length ? <div className="flex flex-wrap gap-2">{keyed.map(reasonChip)}</div> : null}
            {own.length ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-neutral-500">{PASS_WORDS.ownReasons}</p>
                <div className="flex flex-wrap gap-2">{own.map(reasonChip)}</div>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onCancel}>{PASS_WORDS.cancel}</Button>
          <Button onClick={() => onSave(null)}>{PASS_WORDS.blank}</Button>
          <Button tone="primary" disabled={!picked} onClick={() => picked && onSave(picked)}>
            {PASS_WORDS.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
