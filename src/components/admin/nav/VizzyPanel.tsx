"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { Sparkles, X } from "lucide-react";
import { isBrandKitUiEnabled } from "@/lib/content/brandKit";
import { isLifecycleUiEnabled } from "@/lib/lifecycle/flags";
import { activeNavKey, buildNav } from "@/lib/nav/model";
import { vizzySuggestions } from "@/lib/nav/vizzy";
import { ChatPill } from "../chat/ChatPill";
import { MessageThread } from "../chat/MessageThread";
import { isHome, useShell } from "./ShellProvider";

const ITEMS = buildNav({ lifecycle: isLifecycleUiEnabled(), brandKit: isBrandKitUiEnabled(), review: true }).flatMap(
  (s) => s.items,
);

/**
 * Ask Vizzy beside any page (⌘J). It carries the same conversation as Home and
 * tells Vizzy which page is open. Full-screen editors (eBook studio, email
 * layout, node inspectors) sit above it, as they sit above the rest of the shell.
 */
export function VizzyPanel() {
  const shell = useShell();
  const pathname = usePathname() ?? "/admin";
  const panelRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const open = !!shell?.vizzyOpen && !isHome(pathname);
  const exchange = shell?.chat.exchange;

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLTextAreaElement>("[data-vizzy-input]")?.focus();
  }, [open]);

  useEffect(() => {
    if (open && exchange?.length) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [open, exchange, shell?.chat.toolStatus]);

  if (!shell || !open) return null;
  const { chat } = shell;
  const suggestions = vizzySuggestions(activeNavKey(pathname, ITEMS));

  return (
    <aside
      ref={panelRef}
      aria-label="Ask Vizzy"
      className="sticky top-0 flex h-screen w-[380px] shrink-0 flex-col border-l border-shell-line bg-shell-side text-shell-ink"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-shell-line px-4">
        <Sparkles size={16} aria-hidden className="shrink-0 text-shell-accent" />
        <span className="text-sm font-semibold">Vizzy</span>
        <span
          className="min-w-0 truncate rounded-full bg-shell-active px-2 py-0.5 text-xs text-shell-muted"
          title={`Vizzy can see you're on: ${shell.page}`}
        >
          {shell.page}
        </span>
        <button
          type="button"
          onClick={() => shell.setVizzyOpen(false)}
          aria-label="Close Vizzy"
          title="Close (⌘J)"
          className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-shell-muted hover:bg-shell-hover hover:text-shell-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {chat.exchange.length ? (
          <MessageThread
            exchange={chat.exchange}
            isThinking={chat.isThinking}
            currentThought={chat.currentThought}
            toolStatus={chat.toolStatus}
            compact
          />
        ) : (
          <div className="space-y-3 py-6">
            <p className="text-sm text-shell-muted">Ask about this page, or anything else. Try:</p>
            <div className="flex flex-col items-start gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => shell.ask(s)}
                  className="rounded-full border border-shell-line bg-shell-card px-3 py-1.5 text-left text-sm text-shell-ink hover:bg-shell-hover"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-shell-line p-3">
        <ChatPill onSubmit={chat.sendMessage} isLoading={chat.isLoading} mode={chat.mode} onModeChange={chat.setMode} />
        <p className="mt-2 text-center text-[11px] text-shell-faint">Vizzy saves drafts. Publishing stays with you.</p>
      </div>
    </aside>
  );
}
