import { z } from "zod";
import type { ConnectionCatalog, ProductConnection } from "@/lib/types/productConnection";
import type { ContentPool, LifecycleDraft, PoolItem } from "@/lib/types/lifecycle";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { fencedContext } from "@/lib/agents/prompts/compose";
import { generateTextWithDeadline } from "@/lib/agents/gemini";
import { draftEmailCopy } from "@/lib/content/create/emailCopy";
import { buildProductOnboardingDraft } from "./templates/productOnboarding";

/**
 * The lifecycle ARCHITECT — builds a journey from a template + options, then
 * writes on-brand copy for every email. The structure always comes from the
 * template (so a chat-built journey is valid by construction); the model only
 * writes words. Used by the Vizzy chat (canvas kind "lifecycle") and the
 * canvas's Generate button, so both produce the same thing.
 */

export const ArchitectOptionsSchema = z
  .object({
    /** Roughly how many days the sequence runs (the onboarding template is built for 7). */
    days: z.number().int().min(5).max(14).default(7),
    /** Local weekdays emails may go out, 0 = Sunday. */
    sendDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    /** Local "HH:MM" the send window opens. */
    sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    windowMinutes: z.number().int().min(15).max(240).optional(),
    /** How many reminder emails (for people still onboarding): 1–3. */
    reminders: z.number().int().min(1).max(3).default(3),
    /** How many education emails (for people who finished): 1–3. */
    education: z.number().int().min(1).max(3).default(3),
    sender: z
      .object({
        fromName: z.string().trim().max(120).optional(),
        fromEmail: z.string().trim().email().max(254).optional(),
        replyTo: z.string().trim().email().max(254).optional(),
      })
      .optional(),
    categoryLabel: z.string().trim().min(1).max(80).optional(),
    /** Write the copy with AI (false = the template's placeholder copy). */
    writeCopy: z.boolean().default(true),
  })
  .default({ days: 7, reminders: 3, education: 3, writeCopy: true });
export type ArchitectOptions = z.infer<typeof ArchitectOptionsSchema>;

export const LIFECYCLE_ARCHITECT_TEMPLATES = ["product_onboarding"] as const;

/** What each template email is for (the copywriter's brief). */
const PURPOSES: Record<string, string> = {
  w: "Welcome them warmly, show where they are with setup (the checklist) and point them at the next step. A service email: helpful, no selling.",
  r1: "Nudge them towards the ONE next onboarding step and why it's worth doing now, using the product's insight.",
  r2: "Show their progress so far and encourage them to finish the last step.",
  q: "Ask, as a plain personal note, what's blocking them. Invite a one-number reply: 1 Not sure where to start, 2 Waiting on a colleague, 3 Not the right time, 4 Something didn't work.",
  e1: "They're set up: help them read their first results, using the product's insight.",
  e2: "Explain where their results come from, using the product's insight.",
  e3: "Suggest the first improvement worth making, using the product's insight.",
  e4: "Recap their first week, using the product's insight.",
  l: "The last onboarding email: one final, friendly nudge to the step that unlocks the most, and an offer of help.",
};

const BLOCK_HELP: Record<string, string> = {
  "block.checklist": "{{block.checklist}} — their onboarding checklist (✓ done / ☐ to do)",
  "block.next_step": "{{block.next_step}} — a button to their next step",
  "block.insight": "{{block.insight}} — the product's insight about their own data (it contains the numbers)",
};

const ALLOWED_TOKEN = /^(user\.first_name(\|[^}]*)?|product\.name|next_step\.(label|url)|onboarding\.(steps_done|steps_total|steps_remaining)|block\.(checklist|next_step|insight))$/;

function blocksIn(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*(block\.[a-z_]+)\s*\}\}/g)].map((m) => m[1]!))];
}

/** Drop any token the platform wouldn't fill; add back any block the email needs. */
export function tidyCopy(body: string, required: string[]): string {
  let out = body.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (m, inner: string) => (ALLOWED_TOKEN.test(inner) ? m : ""));
  for (const b of required) {
    if (!out.includes(`{{${b}}}`)) out += `\n<p>{{${b}}}</p>`;
  }
  return out.trim();
}

function tidySubject(subject: string): string {
  return subject.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (m, inner: string) => (ALLOWED_TOKEN.test(inner) && !inner.startsWith("block.") ? m : "")).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Scale the template's schedule and apply the options. Pure. */
export function applyOptions(draft: LifecycleDraft, options: ArchitectOptions): LifecycleDraft {
  const scale = options.days / 7;
  const graph = {
    ...draft.graph,
    nodes: draft.graph.nodes.map((n) => {
      if (n.type !== "wait" || !n.data.wait || n.id === "wait_welcome") return n;
      const w = n.data.wait;
      return {
        ...n,
        data: {
          ...n.data,
          wait: {
            ...w,
            minHours: Math.max(12, Math.round(w.minHours * (w.differentLocalDay ? 1 : scale))),
            ...(w.sinceEnrolHours !== undefined ? { sinceEnrolHours: Math.round(w.sinceEnrolHours * scale) } : {}),
          },
        },
      };
    }),
  };
  const counts: Record<string, number> = { reminders: options.reminders, education: options.education };
  const pools: ContentPool[] = draft.pools.map((p) => (counts[p.id] ? { ...p, items: p.items.slice(0, counts[p.id]) } : p));

  const policy = { ...draft.settings.sendPolicy };
  if (options.sendDays) policy.days = [...new Set(options.sendDays)].sort();
  if (options.sendTime) {
    const [h, m] = options.sendTime.split(":").map(Number);
    policy.startHour = h!;
    policy.startMinute = m!;
  }
  if (options.windowMinutes) policy.windowMinutes = options.windowMinutes;
  if (policy.startHour * 60 + policy.startMinute + policy.windowMinutes > 24 * 60) {
    policy.windowMinutes = Math.max(15, 24 * 60 - (policy.startHour * 60 + policy.startMinute));
  }
  policy.hardStopDays = Math.max(options.days + 5, Math.ceil((options.days * 12) / 7));

  return {
    graph,
    pools,
    settings: {
      ...draft.settings,
      sendPolicy: policy,
      sender: {
        fromName: options.sender?.fromName || draft.settings.sender.fromName || null,
        fromEmail: options.sender?.fromEmail || draft.settings.sender.fromEmail || null,
        replyTo: options.sender?.replyTo || draft.settings.sender.replyTo || null,
      },
      category: { ...draft.settings.category, ...(options.categoryLabel ? { label: options.categoryLabel } : {}) },
    },
  };
}

type Generate = (prompt: string) => Promise<string | null>;

async function writeItem(
  item: PoolItem,
  index: { n: number; of: number },
  a: { connection: Pick<ProductConnection, "name" | "catalog">; brief: string; brandVoice: string | null; generate: Generate },
): Promise<{ item: PoolItem; fellBack: boolean }> {
  const required = blocksIn(item.body);
  const steps = [...a.connection.catalog.onboardingSteps].sort((x, y) => x.order - y.order).map((s) => s.label);
  const glossary = a.connection.catalog.glossary.map((g) => `- ${g.term}: ${g.definition}`).join("\n");
  const isReminder = required.includes("block.next_step") || item.id.startsWith("r") || item.id === "l";
  const task = renderPrompt("lifecycle.email_copy", {
    product_name: a.connection.name,
    email_label: item.label,
    position: `email ${index.n} of ${index.of} in the journey`,
    email_purpose: PURPOSES[item.id] ?? item.label,
    style:
      item.format === "letter"
        ? "a short personal note from the founder — plain, human, no marketing polish"
        : "a tidy product email — clear and friendly",
    brief: fencedContext("The operator's brief for the whole journey", "brief", a.brief),
    steps: steps.join(" → ") || "(none)",
    glossary: fencedContext("Product glossary", "glossary", glossary),
    extra_tokens: isReminder ? "- {{next_step.label}} — the next onboarding step for this person" : "",
    required_blocks: required.length
      ? `This email MUST include these blocks, each on its own line:\n${required.map((b) => `- ${BLOCK_HELP[b] ?? `{{${b}}}`}`).join("\n")}`
      : "",
  });
  const drafted = await draftEmailCopy({ task, brandVoice: a.brandVoice, generate: a.generate });
  if (!drafted || !drafted.subject) return { item, fellBack: true };
  return {
    item: {
      ...item,
      subject: tidySubject(drafted.subject) || item.subject,
      previewText: drafted.previewText ? drafted.previewText.replace(/\{\{[^}]*\}\}/g, "").trim().slice(0, 200) || null : item.previewText ?? null,
      body: tidyCopy(drafted.body, required),
      layout: null,
    },
    fellBack: false,
  };
}

/**
 * Build a lifecycle draft: the template's structure for this catalog, the
 * options applied, and (unless writeCopy is false) fresh on-brand copy for each
 * email — three at a time, each bounded by a deadline. An email whose copy
 * can't be written keeps the template's placeholder copy (listed in `notes`).
 */
export async function architectLifecycleDraft(a: {
  connection: Pick<ProductConnection, "name" | "catalog">;
  template?: (typeof LIFECYCLE_ARCHITECT_TEMPLATES)[number];
  options?: unknown;
  brief?: string;
  brandVoice?: string | null;
  generate?: Generate;
}): Promise<{ draft: LifecycleDraft; notes: string[] } | { error: "invalid_options"; detail: string }> {
  const parsed = ArchitectOptionsSchema.safeParse(a.options ?? {});
  if (!parsed.success) return { error: "invalid_options", detail: parsed.error.issues[0]?.message ?? "invalid" };
  const options = parsed.data;
  const draft = applyOptions(buildProductOnboardingDraft(a.connection.catalog as ConnectionCatalog), options);
  if (!options.writeCopy) return { draft, notes: [] };

  const generate: Generate = a.generate ?? ((prompt) => generateTextWithDeadline(prompt, { timeoutMs: 25_000, json: true }));
  const items = draft.pools.flatMap((p) => p.items.map((item) => ({ poolId: p.id, item })));
  const written = new Map<string, PoolItem>();
  const notes: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const { poolId, item } = items[i]!;
      const r = await writeItem(item, { n: i + 1, of: items.length }, {
        connection: a.connection,
        brief: a.brief ?? "",
        brandVoice: a.brandVoice ?? null,
        generate,
      }).catch(() => ({ item, fellBack: true }));
      written.set(`${poolId}:${item.id}`, r.item);
      if (r.fellBack) notes.push(`kept template copy for "${item.label}"`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
  return {
    draft: {
      ...draft,
      pools: draft.pools.map((p) => ({ ...p, items: p.items.map((it) => written.get(`${p.id}:${it.id}`) ?? it) })),
    },
    notes,
  };
}
