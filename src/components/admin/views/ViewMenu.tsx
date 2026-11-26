"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bookmark, Check, ChevronDown, Lock, Users } from "lucide-react";
import { VIEW_MESSAGES } from "@/lib/views/words";
import type { ShownView, ViewLists } from "./viewsApi";

/**
 * People's Views menu (CRM_VIEWS_ENABLED): Everyone with its count, the team's views, the member's
 * own (Only me), and for admins the archived team views with Bring back. Members are told only
 * admins save team views.
 */

/** A small popover that closes on a click away or Escape. */
export function Popover({
  label,
  icon,
  open,
  setOpen,
  align = "left",
  children,
  buttonClass = "",
}: {
  label: ReactNode;
  icon?: ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
  align?: "left" | "right";
  children: ReactNode;
  buttonClass?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, setOpen]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900 ${buttonClass}`}
      >
        {icon}
        {label}
        <ChevronDown size={14} aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute ${align === "right" ? "right-0" : "left-0"} z-30 mt-1 max-h-96 min-w-64 overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{children}</p>;
}

function Row({ icon, label, current, onPick, after }: { icon: ReactNode; label: string; current: boolean; onPick: () => void; after?: ReactNode }) {
  return (
    <div className={`flex items-center gap-2 rounded px-2 py-1.5 ${current ? "bg-neutral-100 dark:bg-neutral-900" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"}`}>
      <button type="button" role="menuitem" onClick={onPick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className="text-neutral-500">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      {current ? <Check size={14} className="text-neutral-500" aria-label="Open now" /> : null}
      {after}
    </div>
  );
}

export function ViewMenu({
  lists,
  everyone,
  current,
  isAdmin,
  onPick,
  onBringBack,
}: {
  lists: ViewLists | null;
  everyone: number | null;
  /** The open view's id; null for the list itself. */
  current: string | null;
  isAdmin: boolean;
  onPick: (view: ShownView | null) => void;
  onBringBack: (view: ShownView) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (v: ShownView | null) => {
    setOpen(false);
    onPick(v);
  };
  return (
    <Popover label="Views" icon={<Bookmark size={14} aria-hidden />} open={open} setOpen={setOpen}>
      <Row icon={<Users size={14} aria-hidden className="opacity-0" />} label="Everyone" current={current === null} onPick={() => pick(null)} after={everyone !== null ? <span className="tabular-nums text-xs text-neutral-500">{everyone.toLocaleString("en-GB")}</span> : null} />
      {!lists ? (
        <p className="px-2 py-1.5 text-neutral-500">Loading…</p>
      ) : (
        <>
          {lists.team.length ? (
            <>
              <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
              <MenuHeading>Team views</MenuHeading>
              {lists.team.map((v) => (
                <Row key={v.id} icon={<Users size={14} aria-hidden />} label={v.name} current={current === v.id} onPick={() => pick(v)} />
              ))}
            </>
          ) : null}
          {lists.mine.length ? (
            <>
              <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
              <MenuHeading>Only me</MenuHeading>
              {lists.mine.map((v) => (
                <Row key={v.id} icon={<Lock size={14} aria-hidden />} label={v.name} current={current === v.id} onPick={() => pick(v)} />
              ))}
            </>
          ) : null}
          {isAdmin && lists.archived.length ? (
            <>
              <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
              <MenuHeading>Archived team views</MenuHeading>
              {lists.archived.map((v) => (
                <Row
                  key={v.id}
                  icon={<Users size={14} aria-hidden />}
                  label={v.name}
                  current={current === v.id}
                  onPick={() => pick(v)}
                  after={
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onBringBack(v);
                      }}
                      className="rounded px-1.5 text-xs underline underline-offset-2 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                    >
                      Bring back
                    </button>
                  }
                />
              ))}
            </>
          ) : null}
          {!lists.team.length && !lists.mine.length ? <p className="px-2 py-1.5 text-xs text-neutral-500">No saved views yet. Add a filter, then Save view.</p> : null}
          {!isAdmin ? (
            <>
              <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
              <p className="px-2 py-1.5 text-xs text-neutral-500">{VIEW_MESSAGES.admins_only}</p>
            </>
          ) : null}
        </>
      )}
    </Popover>
  );
}
