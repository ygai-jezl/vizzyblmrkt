"use client";

import type { FormatInputs, ImageFormatId } from "@/lib/types/imageStyle";

/**
 * A format's own fields (IMAGE_FORMATS_ENABLED), shared by social posts, the blog hero card and
 * the eBook cover. Only the chosen format's fields show. The picture is painted from what the
 * card says: never a person, never the partner's logo.
 */

export const FORMAT_OPTIONS: { id: ImageFormatId; label: string }[] = [
  { id: "standard", label: "Standard" },
  { id: "portrait", label: "Portrait card" },
  { id: "partner", label: "Partner lockup" },
  { id: "report_cover", label: "Report cover" },
];

/** Whether a format has what it needs to be made. */
export function formatReady(format: ImageFormatId, inputs: FormatInputs): boolean {
  if (format === "portrait") return Boolean(inputs.quote?.trim());
  if (format === "partner") return Boolean(inputs.partner?.trim());
  return true;
}

const INPUT =
  "w-full min-w-0 rounded-md border border-neutral-300 px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900";
const NOTE = "mt-1 text-[10px] text-neutral-400";

export function FormatFields({
  format,
  inputs,
  onChange,
  disabled,
}: {
  format: ImageFormatId;
  inputs: FormatInputs;
  onChange: (next: FormatInputs) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<FormatInputs>) => onChange({ ...inputs, ...patch });
  if (format === "portrait") {
    return (
      <div className="mt-2 space-y-1">
        <textarea
          aria-label="Quote"
          value={inputs.quote ?? ""}
          maxLength={240}
          rows={2}
          disabled={disabled}
          onChange={(e) => set({ quote: e.target.value })}
          placeholder="Their words (put *stars* round the phrase to light up)"
          className={INPUT}
        />
        <div className="flex gap-1">
          <input aria-label="Name" value={inputs.name ?? ""} maxLength={80} disabled={disabled} onChange={(e) => set({ name: e.target.value })} placeholder="Name" className={INPUT} />
          <input aria-label="Role" value={inputs.role ?? ""} maxLength={80} disabled={disabled} onChange={(e) => set({ role: e.target.value })} placeholder="Role" className={INPUT} />
        </div>
        <p className={NOTE}>The picture is a painted scene that fits the quote, never a person.</p>
      </div>
    );
  }
  if (format === "partner") {
    return (
      <div className="mt-2 space-y-1">
        <input aria-label="Partner's name" value={inputs.partner ?? ""} maxLength={60} disabled={disabled} onChange={(e) => set({ partner: e.target.value })} placeholder="Partner's name" className={INPUT} />
        <input aria-label="One line" value={inputs.line ?? ""} maxLength={140} disabled={disabled} onChange={(e) => set({ line: e.target.value })} placeholder="One line (blank: your post's first line)" className={INPUT} />
        <p className={NOTE}>Shown as your logo × their name in type. Their logo is never drawn.</p>
      </div>
    );
  }
  if (format === "report_cover") {
    return (
      <div className="mt-2 space-y-1">
        <input aria-label="Title" value={inputs.title ?? ""} maxLength={140} disabled={disabled} onChange={(e) => set({ title: e.target.value })} placeholder="Title (blank: your words)" className={INPUT} />
        <input aria-label="Subtitle" value={inputs.subtitle ?? ""} maxLength={200} disabled={disabled} onChange={(e) => set({ subtitle: e.target.value })} placeholder="Subtitle" className={INPUT} />
        <div className="flex gap-1">
          <input
            aria-label="Big number"
            value={inputs.figure?.value ?? ""}
            maxLength={14}
            disabled={disabled}
            onChange={(e) => set({ figure: e.target.value ? { value: e.target.value, unit: inputs.figure?.unit ?? "" } : undefined })}
            placeholder="Big number"
            className={`${INPUT} w-28`}
          />
          <input
            aria-label="Its unit"
            value={inputs.figure?.unit ?? ""}
            maxLength={24}
            disabled={disabled || !inputs.figure?.value}
            onChange={(e) => set({ figure: { value: inputs.figure?.value ?? "", unit: e.target.value } })}
            placeholder="Unit"
            className={INPUT}
          />
        </div>
      </div>
    );
  }
  return null;
}
