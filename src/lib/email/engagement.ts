import type { EmailEngagement, EmailSend } from "@/lib/types/emailSend";
import type { MandrillEvent } from "./mandrillWebhook";

/**
 * Every open, click and bounce detail of one email (EMAIL_ENGAGEMENT_DETAIL_ENABLED), worked out
 * from a webhook batch's events for it. Pure. A batch Mandrill sends again counts nothing twice:
 * each event's key is remembered (the last SEEN_MAX of them), and when Mandrill lists the opens or
 * clicks so far on the message, the count is never below that list's length.
 *
 * Privacy: no IP address or location is kept. A clicked link keeps only its origin and path, with
 * any part that looks like a token replaced. A bounce's diagnostic has addresses replaced.
 */

export const SEEN_MAX = 40;
export const LINKS_MAX = 20;
export const CLIENTS_MAX = 10;

const iso = (ts: number | undefined, fallback: string) => (typeof ts === "number" && ts > 0 ? new Date(ts * 1000).toISOString() : fallback);
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/** Origin and path only; path parts that look like secrets (long ids, hex, base64) become ":token". */
export function scrubLink(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((part) => (/^[A-Za-z0-9_-]{20,}$/.test(part) || /^[0-9a-f]{16,}$/i.test(part) ? ":token" : part))
      .join("/");
    return `${u.origin}${path}`.slice(0, 300);
  } catch {
    return "";
  }
}

/** A bounce diagnostic with email addresses replaced, capped. */
export function scrubDiag(diag: string): string {
  return diag.replace(/<?[^\s<>@]+@[^\s<>@]+>?/g, "<address>").slice(0, 200);
}

function mobileOf(ev: MandrillEvent): boolean | null {
  const p = (ev as { user_agent_parsed?: { mobile?: unknown } }).user_agent_parsed;
  return p && typeof p.mobile === "boolean" ? p.mobile : null;
}

function clientOf(ev: MandrillEvent): string {
  const p = (ev as { user_agent_parsed?: { ua_family?: unknown } }).user_agent_parsed;
  return p ? str(p.ua_family, 60) : "";
}

const listLength = (ev: MandrillEvent, key: "opens" | "clicks"): number => {
  const list = ev.msg?.[key];
  return Array.isArray(list) ? list.length : 0;
};

function topEntries(rec: Record<string, number>, max: number): Record<string, number> {
  return Object.fromEntries(Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, max));
}

/** The update to a send record for these events, or null when nothing changed. */
export function applyEngagement(
  current: EmailEngagement & Pick<EmailSend, "mandrillMessageId">,
  events: MandrillEvent[],
  nowIso: string = new Date().toISOString(),
): (EmailEngagement & Pick<EmailSend, "mandrillMessageId">) | null {
  const seen = [...(current.seen ?? [])];
  const out: EmailEngagement & Pick<EmailSend, "mandrillMessageId"> = {};
  let opens = current.opens ? { ...current.opens, clients: { ...current.opens.clients } } : undefined;
  let clicks = current.clicks ? { ...current.clicks, links: current.clicks.links.map((l) => ({ ...l })) } : undefined;
  let changed = false;

  for (const ev of events) {
    const at = iso(ev.ts, nowIso);
    const key = `${ev.event}:${ev.ts ?? ""}:${ev.url ?? ""}`;
    if (seen.includes(key)) continue;
    seen.push(key);
    changed = true;
    if (!current.mandrillMessageId && !out.mandrillMessageId && typeof ev.msg?._id === "string") out.mandrillMessageId = ev.msg._id;
    switch (ev.event) {
      case "open": {
        opens ??= { count: 0, firstAt: at, lastAt: at, mobile: 0, desktop: 0, clients: {} };
        opens.count = Math.max(opens.count + 1, listLength(ev, "opens"));
        if (at < opens.firstAt) opens.firstAt = at;
        if (at > opens.lastAt) opens.lastAt = at;
        const mobile = mobileOf(ev);
        if (mobile === true) opens.mobile += 1;
        else if (mobile === false) opens.desktop += 1;
        const client = clientOf(ev);
        if (client) opens.clients = topEntries({ ...opens.clients, [client]: (opens.clients[client] ?? 0) + 1 }, CLIENTS_MAX);
        break;
      }
      case "click": {
        clicks ??= { count: 0, firstAt: at, lastAt: at, links: [] };
        clicks.count = Math.max(clicks.count + 1, listLength(ev, "clicks"));
        if (at < clicks.firstAt) clicks.firstAt = at;
        if (at > clicks.lastAt) clicks.lastAt = at;
        const link = ev.url ? scrubLink(ev.url) : "";
        if (link) {
          const found = clicks.links.find((l) => l.url === link);
          if (found) found.count += 1;
          else if (clicks.links.length < LINKS_MAX) clicks.links.push({ url: link, count: 1 });
        }
        break;
      }
      case "hard_bounce":
      case "soft_bounce": {
        const kind = ev.event === "hard_bounce" ? "hard" : "soft";
        // A hard bounce is the one that matters; a soft one never replaces it.
        if (kind === "hard" || current.bounce?.kind !== "hard") {
          out.bounce = { kind, description: str(ev.msg?.bounce_description, 80), diag: scrubDiag(str(ev.msg?.diag, 400)), at };
        }
        break;
      }
      case "reject":
        out.reject = { reason: str(ev.msg?.reject && typeof ev.msg.reject === "object" ? (ev.msg.reject as { reason?: unknown }).reason : ev.msg?.state, 80), at };
        break;
      case "delivered":
        out.deliveredAt = current.deliveredAt ?? at;
        break;
      case "deferral": {
        const d = out.deferrals ?? current.deferrals ?? { count: 0, lastAt: at };
        out.deferrals = { count: d.count + 1, lastAt: at > d.lastAt ? at : d.lastAt };
        break;
      }
      case "spam":
        out.spamAt = current.spamAt ?? at;
        break;
      case "unsub":
        out.unsubAt = current.unsubAt ?? at;
        break;
      default:
        break;
    }
  }
  if (!changed) return null;
  if (opens) out.opens = opens;
  if (clicks) out.clicks = clicks;
  out.seen = seen.slice(-SEEN_MAX);
  return out;
}
