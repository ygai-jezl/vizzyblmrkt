import { embedDocument } from "@/lib/agents/embeddings";
import { writePerformanceExemplar } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";

/**
 * Record a proven performer as a `performance_exemplars` vector row: embed its
 * (scrubbed, capped) copy and store it for retrieval into future Create generations.
 * Fail-soft: if embeddings are unconfigured / the embed fails, it SKIPS (never
 * throws — the closed loop is best-effort). Idempotent: one exemplar per source post
 * (tenant-namespaced id), so a re-poll of the same post overwrites, not duplicates.
 */
export const MAX_EXEMPLAR_CHARS = 4000;
const MAX_TAGS = 20;

export interface RecordExemplarInput {
  channel: string;
  /** The proven copy (the published post body). */
  text: string;
  tags?: string[];
  metric: { name: string; value: number };
  /** Source scheduled-post id (dedupe/link-back). */
  sourcePostId: string;
  sourceRemoteId?: string | null;
}

export interface RecordExemplarDeps {
  embed?: typeof embedDocument;
  write?: typeof writePerformanceExemplar;
}

/**
 * Defensive PII scrub before embedding/storing.
 *
 * INVARIANT (caller contract): `input.text` MUST be OUR OWN machine-generated post
 * copy — NEVER user-authored text (a reply/quote/DM body, a pasted testimonial). This
 * store is shared per-region and its rows are injected back into LLM prompts, so
 * user PII must never reach it. The scrub is defence-in-depth for that invariant, not
 * a substitute: it redacts emails (incl. common "at/dot" obfuscation), @handles, and
 * phone-ish digit runs, but does not attempt to catch names/addresses.
 */
export function scrubExemplarText(text: string): string {
  return text
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[email]")
    // Obfuscated email: "joe [at] acme [dot] com" / "joe(at)acme dot com".
    .replace(
      /\b[\w.+-]+\s*[[({]?\s*at\s*[\])}]?\s*[\w-]+\s*[[({]?\s*dot\s*[\])}]?\s*\w{2,}\b/gi,
      "[email]",
    )
    .replace(/(?<!\w)@\w{2,}/g, "[handle]")
    // Phone-ish: a digit-run with separators ((), spaces, dashes, +). Only redact
    // when it actually holds ≥9 digits, so a year range like "2020-2024" is kept.
    .replace(/\+?\d[\d\s().+-]{7,}\d/g, (m) => ((m.match(/\d/g) ?? []).length >= 9 ? "[number]" : m))
    .trim();
}

export async function recordExemplar(
  ctx: TenantContext,
  input: RecordExemplarInput,
  deps: RecordExemplarDeps = {},
): Promise<"recorded" | "skipped"> {
  const embed = deps.embed ?? embedDocument;
  const write = deps.write ?? writePerformanceExemplar;

  const text = scrubExemplarText(input.text).slice(0, MAX_EXEMPLAR_CHARS);
  if (!text) return "skipped";

  const vector = await embed(text, ctx.region);
  if (!vector) return "skipped"; // embeddings off / failed → skip, don't block the loop

  const tags = (input.tags ?? [])
    .map((t) => String(t).trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, MAX_TAGS);

  await write(
    ctx,
    {
      // Encode the tenantId segment so a colon in a tenantId can never bridge the
      // delimiter and collide across tenants in the shared regional collection.
      id: `pex:${encodeURIComponent(ctx.tenantId)}:${input.sourcePostId}`,
      channel: input.channel,
      text,
      tags,
      metric: { name: input.metric.name, value: input.metric.value },
      sourcePostId: input.sourcePostId,
      sourceRemoteId: input.sourceRemoteId ?? null,
      createdAt: new Date().toISOString(),
    },
    vector,
  );
  return "recorded";
}
