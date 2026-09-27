import {
  escapeHtml,
  hasFooter,
  htmlToText,
  isSafeHref,
  looksHtml,
  paragraphize,
  preheaderHtml,
  renderEmailLayout,
  renderFooter,
  wrap,
  wrapLetter,
} from "@/lib/email/emailRender";
import { accentFor, readableOn, type ResolvedEmailStyle } from "@/lib/email/emailStyle";
import type { FooterMergeValues } from "@/lib/email/mergeVars";
import type { PoolItem } from "@/lib/types/lifecycle";
import type { TraitValue } from "@/lib/types/productUser";

/**
 * Render one lifecycle email for one recipient, at send time.
 *
 * Tokens: `{{user.first_name}}`, `{{trait.plan}}`, `{{fact.share_of_voice}}`,
 * `{{next_step.label}}`, `{{next_step.url}}`, `{{product.name}}`,
 * `{{onboarding.steps_remaining}}`, … each with an optional fallback:
 * `{{user.first_name|there}}`. Blocks: `{{block.checklist}}`,
 * `{{block.next_step}}`, `{{block.insight}}` and `{{block.entities}}` render
 * live HTML. With API v2 entities: `{{entity.name}}`, `{{entity.kind}}` (the one
 * an email is about) and `{{entities.count}}`.
 *
 * ONE pass over the template: a value is inserted escaped and never re-scanned,
 * so a product-supplied value containing "{{…}}" stays literal. A token with no
 * value and no fallback renders empty and is reported in `missing` — the runner
 * never sends an item with missing tokens (it moves on to the next eligible one).
 * An absent block (no insight, no next step) simply renders nothing.
 *
 * Link hygiene: every href in the output must pass isSafeHref, or it becomes "#".
 * Links that came from the product's context are filtered to https on the
 * connection's link domains before they get here (recipientContext).
 *
 * Email style: a `branded` email gets the header band and the button colour
 * (next-step button; checklist links and the insight rule when readable). A
 * `letter` stays plain. No style = today's output. Pure + client-safe: the
 * journey editor previews with it, so the style arrives resolved, as data.
 */

export interface RenderValues {
  user: { id: string; first_name?: string | null; last_name?: string | null; email?: string | null };
  product: { name: string };
  traits: Record<string, TraitValue>;
  facts: Array<{ id: string; label: string; value: string | number | boolean; unit?: string | null; display?: string | null }>;
  nextStep: { label: string; url: string | null } | null;
  checklist: Array<{ label: string; done: boolean; url: string | null }>;
  insight: { sentence: string; aiLine?: string | null } | null;
  footer: FooterMergeValues & { postalAddress?: string | null };
  /** API v2 entities: the one this email is about (`{{entity.name}}`, `{{entity.kind}}`). */
  entity?: { name: string | null; kind: string } | null;
  /** The ones the journey counts: `{{entities.count}}` and `{{block.entities}}` (a digest). */
  entities?: {
    count: number;
    rows: Array<{ name: string; done: number; total: number; facts: Array<{ label: string; value: string }> }>;
    more: number;
  } | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  missing: string[];
  /** The insight block rendered an insight (the runner marks it used). */
  insightUsed: boolean;
}

const TOKEN_RE = /\{\{\s*([A-Za-z_][\w.]*)\s*(?:\|([^}]*))?\}\}/g;
const FONT = "system-ui,-apple-system,Segoe UI,Roboto,sans-serif";

function valueFor(key: string, v: RenderValues): string | undefined {
  const dot = key.indexOf(".");
  const ns = dot < 0 ? key : key.slice(0, dot);
  const k = dot < 0 ? "" : key.slice(dot + 1);
  const str = (x: unknown) => (x === null || x === undefined || x === "" ? undefined : String(x));
  switch (ns) {
    case "user":
      if (k === "first_name") return str(v.user.first_name);
      if (k === "last_name") return str(v.user.last_name);
      if (k === "email") return str(v.user.email);
      if (k === "id") return str(v.user.id);
      return undefined;
    case "product":
      return k === "name" ? str(v.product.name) : undefined;
    case "trait":
      return Object.prototype.hasOwnProperty.call(v.traits, k) ? str(v.traits[k]) : undefined;
    case "fact": {
      const f = v.facts.find((x) => x.id === k);
      return f ? (str(f.display) ?? `${f.value}${f.unit ?? ""}`) : undefined;
    }
    case "next_step":
      if (!v.nextStep) return undefined;
      if (k === "label") return str(v.nextStep.label);
      if (k === "url") return v.nextStep.url && isSafeHref(v.nextStep.url) ? v.nextStep.url : undefined;
      return undefined;
    case "entity":
      if (k === "name") return str(v.entity?.name);
      if (k === "kind") return str(v.entity?.kind);
      return undefined;
    case "entities":
      return k === "count" && v.entities ? String(v.entities.count) : undefined;
    case "onboarding": {
      const done = v.checklist.filter((s) => s.done).length;
      if (k === "steps_done") return String(done);
      if (k === "steps_total") return String(v.checklist.length);
      if (k === "steps_remaining") return String(v.checklist.length - done);
      return undefined;
    }
    // Footer tokens (no namespace).
    case "sender_brand":
      return str(v.footer.brand);
    case "unsubscribe_url":
      return str(v.footer.unsubscribeUrl);
    case "manage_preferences_url":
      return str(v.footer.managePreferencesUrl);
    case "privacy_url":
      return str(v.footer.privacyUrl);
    case "postal_address":
      return str(v.footer.postalAddress);
    default:
      return undefined;
  }
}

function checklistBlock(steps: RenderValues["checklist"], emailStyle: ResolvedEmailStyle | null): string {
  if (steps.length === 0) return "";
  const link = accentFor(emailStyle, "link") ?? "#111";
  const rows = steps
    .map((s) => {
      const label = escapeHtml(s.label);
      const linked =
        !s.done && s.url && isSafeHref(s.url)
          ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" style="color:${link};text-decoration:underline">${label}</a>`
          : label;
      const style = s.done ? "color:#8a8a8a;text-decoration:line-through" : "color:#111";
      return `<tr><td style="padding:4px 10px 4px 0;font-size:16px;vertical-align:top">${s.done ? "✓" : "☐"}</td><td style="padding:4px 0;font-family:${FONT};font-size:15px;${style}">${linked}</td></tr>`;
    })
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;border-collapse:collapse">${rows}</table>`;
}

/** One line per entity: its name, its progress, and a few of its facts. Nothing when there are none. */
function entitiesBlock(e: RenderValues["entities"], letter: boolean): string {
  if (!e || e.rows.length === 0) return "";
  const line = (r: NonNullable<RenderValues["entities"]>["rows"][number]) => {
    const parts = [
      ...(r.total > 0 ? [`${r.done} of ${r.total} steps done`] : []),
      ...r.facts.map((f) => `${f.label}: ${f.value}`),
    ];
    return `<strong>${escapeHtml(r.name)}</strong>${parts.length ? ` — ${escapeHtml(parts.join(" · "))}` : ""}`;
  };
  const more = e.more > 0 ? `and ${e.more} more` : "";
  if (letter) return `<p style="margin:0 0 16px">${e.rows.map(line).join("<br>")}${more ? `<br>${more}` : ""}</p>`;
  const rows = e.rows
    .map((r) => `<tr><td style="padding:6px 0;font-family:${FONT};font-size:15px;color:#111;border-bottom:1px solid #eee">${line(r)}</td></tr>`)
    .join("");
  const tail = more ? `<tr><td style="padding:6px 0;font-family:${FONT};font-size:14px;color:#8a8a8a">${more}</td></tr>` : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;border-collapse:collapse;width:100%">${rows}${tail}</table>`;
}

function nextStepBlock(next: RenderValues["nextStep"], letter: boolean, emailStyle: ResolvedEmailStyle | null): string {
  if (!next) return "";
  const label = escapeHtml(next.label);
  if (!next.url || !isSafeHref(next.url)) return `<p style="margin:0 0 16px"><strong>${label}</strong></p>`;
  const href = escapeHtml(next.url);
  if (letter) return `<p style="margin:0 0 16px"><a href="${href}" target="_blank" rel="noopener noreferrer">${label} →</a></p>`;
  const accent = accentFor(emailStyle, "button");
  const bg = accent ?? "#111111";
  const ink = accent ? readableOn(accent) : "#ffffff";
  return `<div style="margin:8px 0 20px"><table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-block;border-collapse:separate"><tr><td bgcolor="${bg}" style="background:${bg};border-radius:8px"><a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;color:${ink};text-decoration:none">${label} →</a></td></tr></table></div>`;
}

function insightBlock(insight: RenderValues["insight"], letter: boolean, emailStyle: ResolvedEmailStyle | null): string {
  if (!insight) return "";
  const text = escapeHtml(insight.aiLine ? `${insight.sentence} ${insight.aiLine}` : insight.sentence);
  if (letter) return `<p style="margin:0 0 16px">${text}</p>`;
  const rule = accentFor(emailStyle, "rule") ?? "#111";
  return `<div style="margin:8px 0 16px;padding:12px 14px;border-left:3px solid ${rule};background:#f6f6f6;font-family:${FONT};font-size:15px;line-height:1.6;color:#111">${text}</div>`;
}

interface RenderState {
  missing: Set<string>;
  insightUsed: boolean;
  /** The Email style whose accent the blocks use; null = today's #111 (always, for letters). */
  emailStyle: ResolvedEmailStyle | null;
}

function renderTokens(
  template: string,
  v: RenderValues,
  mode: "html" | "text",
  letter: boolean,
  st: RenderState,
): string {
  const missing = st.missing;
  return template.replace(TOKEN_RE, (_m, key: string, fallback?: string) => {
    if (key.startsWith("block.")) {
      if (mode === "text") return "";
      if (key === "block.checklist") return checklistBlock(v.checklist, st.emailStyle);
      if (key === "block.next_step") return nextStepBlock(v.nextStep, letter, st.emailStyle);
      if (key === "block.entities") return entitiesBlock(v.entities, letter);
      if (key === "block.insight") {
        if (v.insight) st.insightUsed = true;
        return insightBlock(v.insight, letter, st.emailStyle);
      }
      missing.add(key);
      return "";
    }
    const value = valueFor(key, v) ?? (fallback !== undefined ? fallback.trim() : undefined);
    if (value === undefined) {
      missing.add(key);
      return "";
    }
    return mode === "html" ? escapeHtml(value) : value;
  });
}

/** Replace any href that isn't a safe link (javascript:, an unresolved token, "") with "#". */
function neutralizeUnsafeHrefs(html: string): string {
  return html.replace(/\bhref="([^"]*)"/gi, (m, raw: string) => {
    const href = raw
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    return isSafeHref(href) && !href.includes("{{") ? m : 'href="#"';
  });
}

function shadowBanner(realRecipient: string): string {
  return `<div style="margin:0 0 16px;padding:10px 12px;background:#fff7d6;border:1px solid #f0d78c;border-radius:6px;font-family:${FONT};font-size:13px;color:#6b5500">Shadow mode — in live mode this email would go to <strong>${escapeHtml(realRecipient)}</strong>.</div>`;
}

export function renderLifecycleEmail(input: {
  item: Pick<PoolItem, "subject" | "body" | "previewText" | "format" | "layout">;
  values: RenderValues;
  /** Shadow mode: the real recipient, shown in a banner at the top. */
  shadowFor?: string | null;
  /** The tenant's resolved Email style (branded emails only); null/absent = today's look. */
  style?: ResolvedEmailStyle | null;
}): RenderedEmail {
  const { item, values } = input;
  const letter = item.format === "letter";
  // Letters stay plain: no band, and the blocks keep today's colours.
  const style = letter ? null : (input.style ?? null);
  const st: RenderState = { missing: new Set<string>(), insightUsed: false, emailStyle: style };

  const subject = renderTokens(item.subject, values, "text", letter, st).replace(/[\r\n]+/g, " ").trim();

  // A saved layout is re-rendered (and so re-sanitised) at send. Plain-text bodies
  // (typical for letters) are escaped and paragraphed first; a block token alone
  // on a line becomes its own element rather than a <p> child.
  const source = item.layout ? renderEmailLayout(item.layout) : item.body;
  let inner = looksHtml(source) ? source : paragraphize(escapeHtml(source));
  inner = inner.replace(/<p>\s*(\{\{\s*block\.[a-z_]+\s*\}\})\s*<\/p>/g, "$1");
  if (!hasFooter(inner)) inner += renderFooter(null, { withAddress: Boolean(values.footer.postalAddress) });

  const body =
    (input.shadowFor ? shadowBanner(input.shadowFor) : "") +
    neutralizeUnsafeHrefs(renderTokens(inner, values, "html", letter, st));
  const preheader = item.previewText ? renderTokens(item.previewText, values, "text", letter, st) : null;
  return {
    subject,
    // wrap() puts the preheader ahead of the band, so the band never becomes the inbox snippet.
    html: letter ? wrapLetter(preheaderHtml(preheader) + body) : wrap(body, null, { style, preheader }),
    text: htmlToText(body),
    missing: [...st.missing],
    insightUsed: st.insightUsed,
  };
}
