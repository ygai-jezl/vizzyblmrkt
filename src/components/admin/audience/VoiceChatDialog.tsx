"use client";

import { useEffect, useState } from "react";
import type { VoiceChat } from "@/lib/audience/voiceChat";
import { api } from "../connect/api";
import { Banner } from "../connect/ui";
import { Modal } from "../email/Modal";
import { day } from "../people/format";

/**
 * Read the conversation: one voice chat on a sign-up page, in full. Admins only (the route
 * refuses anyone else). It is exported and erased with the person.
 */
export function VoiceChatDialog({ personId, signupId, onClose }: { personId: string; signupId: string; onClose: () => void }) {
  const [chat, setChat] = useState<VoiceChat | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api<{ chat: VoiceChat }>(`/api/admin/audience/everyone/${encodeURIComponent(personId)}/conversation?signup=${encodeURIComponent(signupId)}`).then((r) =>
      r.ok ? setChat(r.data.chat) : setFailed(true),
    );
  }, [personId, signupId]);

  const them = chat?.personName?.split(" ")[0] || "Them";
  return (
    <Modal open onClose={onClose} title="Read the conversation">
      {failed ? (
        <Banner tone="err">Couldn&rsquo;t load this conversation. Only admins can read it, and it may have been erased.</Banner>
      ) : !chat ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <p className="font-medium">Voice chat on the {chat.launchName} sign-up page</p>
            <p className="text-xs text-neutral-500">
              {[chat.personName, day(chat.at), `${chat.turns.length} ${chat.turns.length === 1 ? "turn" : "turns"}`].filter(Boolean).join(" · ")}
            </p>
          </div>
          {chat.summary ? (
            <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <q className="italic">{chat.summary}</q>
              <p className="mt-1 text-xs text-neutral-500">Summary sent by their browser when the chat ended. We haven&rsquo;t checked it.</p>
            </div>
          ) : null}
          <ol className="space-y-3">
            {chat.turns.map((t, i) => (
              <li key={i} className={t.role === "user" ? "pl-6" : "pr-6"}>
                <span className="block text-xs text-neutral-500">{t.role === "user" ? them : `Vizzy, for ${chat.brandName}`}</span>
                <span className="block whitespace-pre-wrap">{t.text}</span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-neutral-500">Only admins can read this. It is exported and erased with the person.</p>
          <p className="text-xs text-neutral-500">Using what they said to suggest field values comes later, with Voice chat insights.</p>
        </div>
      )}
    </Modal>
  );
}
