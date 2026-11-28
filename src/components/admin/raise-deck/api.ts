import type { DeckView } from "@/lib/raise/docs/adminApi";
import type { Check } from "@/lib/raise/docs/checks";
import type { SaveBody } from "@/lib/raise/docs/edit";
import type { Slide } from "@/lib/raise/docs/types";
import { RAISE_MESSAGES } from "@/lib/raise/docs/words";

/**
 * The studio's and the list's calls to the Raise kit's admin API (/api/admin/raise/docs). Never
 * throws: every answer is { ok, status, data }, and `messageFor` turns an error into the words
 * people read.
 */

export interface Answer<T> {
  ok: boolean;
  status: number;
  data: T & { error?: string; version?: number };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<Answer<T>> {
  try {
    const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    const data = (await res.json().catch(() => ({}))) as Answer<T>["data"];
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "network" } as Answer<T>["data"] };
  }
}

const BASE = "/api/admin/raise/docs";
const one = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const newDeck = (body: { audience: "investor" | "lender"; stage?: "pre_seed" | "seed"; brief?: string }) =>
  call<{ doc?: DeckView; drafted?: boolean; warnings?: string[] }>(BASE, post(body));

export const readDeck = (id: string) => call<{ doc?: DeckView }>(one(id));

export const saveDeck = (id: string, body: SaveBody) => call<{ doc?: DeckView; saved?: boolean }>(one(id), { method: "PUT", body: JSON.stringify(body) });

export const deleteDeck = (id: string) => call<{ ok?: boolean }>(one(id), { method: "DELETE" });

export const refreshNumbers = (id: string, baseVersion: number) =>
  call<{ doc?: DeckView; changed?: Array<{ slideN: number; name: string; from: string; to: string }> }>(`${one(id)}/numbers`, post({ baseVersion }));

export interface KeptVersion {
  n: number;
  note: string;
  by: string;
  at: string;
  title: string;
  slides: Slide[];
  checks: Check[];
}

export const readVersion = (id: string, n: number) => call<{ version?: KeptVersion }>(`${one(id)}/versions/${n}`);

export const restoreVersion = (id: string, n: number, baseVersion: number) => call<{ doc?: DeckView }>(`${one(id)}/versions/${n}/restore`, post({ baseVersion }));

/** Download data: the export route sends the deck as a file. */
export const exportHref = (id: string) => `${one(id)}/export`;

/** The words for an error Save changes got back: a field the save refused is too long or empty. */
export function saveMessageFor(error: string | undefined): string {
  return error === "invalid_input" ? RAISE_MESSAGES.tooLong : messageFor(error);
}

/** The words for an error the API answered with. */
export function messageFor(error: string | undefined): string {
  switch (error) {
    case "not_included":
      return RAISE_MESSAGES.notIncluded;
    case "forbidden":
      return RAISE_MESSAGES.memberOnly;
    case "deck_limit":
      return RAISE_MESSAGES.deckLimit;
    case "rate_limited":
      return RAISE_MESSAGES.rateLimited;
    case "stale_version":
      return RAISE_MESSAGES.stale;
    case "version_not_kept":
      return RAISE_MESSAGES.versionNotKept;
    default:
      return RAISE_MESSAGES.failed;
  }
}
