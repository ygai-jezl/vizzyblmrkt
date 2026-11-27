"use client";

import { editSegments, withSegmentText } from "@/lib/raise/docs/edit";
import { renderText } from "@/lib/raise/docs/text";
import type { MetricBlock } from "@/lib/raise/docs/types";
import { NumberChip } from "./NumberChip";

const FIELD = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

export interface TokenTextProps {
  id: string;
  label: string;
  value: string;
  blocks: readonly MetricBlock[];
  onChange: (value: string) => void;
  /** The person is in this field: a number inserted next goes here. */
  onFocus?: () => void;
  onRemoveBlock?: (blockId: string) => void;
  multiline?: boolean;
  readOnly?: boolean;
  maxLength: number;
  placeholder?: string;
  now: Date;
}

/**
 * A slide's text with its numbers as chips. Plain words are typed as usual; a number sits in the
 * text as a chip that can't be typed over, so the figure always comes from its block. Text with no
 * numbers is a plain field.
 */
export function TokenText({ id, label, value, blocks, onChange, onFocus, onRemoveBlock, multiline, readOnly, maxLength, placeholder, now }: TokenTextProps) {
  const segs = editSegments(value);
  const hasTokens = segs.some((s) => s.kind === "block");
  const labelEl = (
    <label htmlFor={id} className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">
      {label}
    </label>
  );
  if (readOnly) {
    return (
      <div className="space-y-1">
        {labelEl}
        <p id={id} className="whitespace-pre-wrap text-sm">
          {renderText(value, blocks) || " "}
        </p>
      </div>
    );
  }
  if (!hasTokens) {
    const common = { id, value, maxLength, placeholder, onFocus, onChange: (e: { target: { value: string } }) => onChange(e.target.value), className: FIELD };
    return (
      <div className="space-y-1">
        {labelEl}
        {multiline ? <textarea rows={4} {...common} /> : <input type="text" {...common} />}
      </div>
    );
  }
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return (
    <div className="space-y-1">
      {labelEl}
      <div className={`${FIELD} flex flex-wrap items-center gap-y-1`} onFocus={onFocus}>
        {segs.map((s, i) =>
          s.kind === "block" ? (
            <NumberChip key={`b${i}`} block={byId.get(s.id)} part={s.part} now={now} canEdit onRemove={onRemoveBlock ? () => onRemoveBlock(s.id) : undefined} />
          ) : (
            <input
              key={`t${i}`}
              id={i === 0 ? id : undefined}
              aria-label={i === 0 ? undefined : label}
              type="text"
              value={s.text}
              size={Math.max(2, s.text.length + 1)}
              onChange={(e) => {
                const next = withSegmentText(value, i, e.target.value);
                if (next.length <= maxLength) onChange(next);
              }}
              className="min-w-[1.5rem] max-w-full flex-auto bg-transparent outline-none"
            />
          ),
        )}
      </div>
    </div>
  );
}
