"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";

/** Small pieces the Brand map editor's sections share. */

export function Issues({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <ul className="space-y-0.5 text-xs text-red-600 dark:text-red-400">
      {messages.map((m, i) => (
        <li key={i}>{m}</li>
      ))}
    </ul>
  );
}

export function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
    >
      <X size={14} aria-hidden />
    </button>
  );
}

/** A text box and an Add button; Enter adds too. Empty text adds nothing. */
export function AddLine({
  label,
  placeholder,
  onAdd,
  disabled,
  maxLength,
  button = "Add",
}: {
  label: string;
  placeholder?: string;
  onAdd: (text: string) => boolean | void;
  disabled?: boolean;
  maxLength?: number;
  button?: string;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const value = text.replace(/\s+/g, " ").trim();
    if (!value) return;
    if (onAdd(value) !== false) setText("");
  };
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={label}
        className={inputClass}
        placeholder={placeholder}
        value={text}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
      />
      <Button onClick={add} disabled={disabled || !text.trim()}>
        {button}
      </Button>
    </div>
  );
}

export const smallLabel = "block text-xs font-medium text-neutral-600 dark:text-neutral-400";
