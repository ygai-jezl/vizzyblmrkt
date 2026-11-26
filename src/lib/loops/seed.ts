import { canonicalStyleId } from "@/lib/content/imageStyle/catalogue";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { readBrandPointers, readBrandPointersTx, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersionTx } from "@/lib/tenant/patternVersions";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandPointers } from "@/lib/types/loopDay";
import type { Tenant } from "@/lib/types/tenant";
import { BRAND_SCOPE } from "./read";
import { IMAGE_STYLE_SCOPES, type ImageStyleScope } from "./registry";
import { checkLookText } from "./write";

/**
 * The seed (learning loops step 4, 3.7 of the plan for steps 4 and 5): the looks a brand learned
 * before versions, kept on its brand record in the United States (`brandKit.learnedImageStyle`
 * and `imageStyle.learned[style].directive`), copied once into version 1 of their scopes in the
 * brand's own region, with `createdBy: "seed"` and `setBy: "seeded"`, in one regional transaction
 * that also writes `seededAt`. Until then images use the old field, stamped legacy.
 *
 * The lane seeds a brand on its first visit (4.6); Reset seeds first when the brand isn't seeded
 * yet, so clearing the old copy never loses a look (decision 17). The old copy stays where it is,
 * for switching versions off, until Forget, Reset or the dated cleanup clears it.
 *
 * A look whose words fail the loops' one text check (a link, email address, handle or phone
 * number) is not carried over: no version ever holds words the one writer would refuse. Only
 * looks of styles that learn are carried; a drawn style never had one that was used. Server only.
 */

export interface SeedDeps {
  db?: FirestoreLike;
  now?: Date;
}

export type SeedResult =
  | { ok: true; seeded: true; scopes: ImageStyleScope[]; refused: string[] }
  | { ok: true; seeded: false; why: "switch" | "already" }
  | { ok: false; error: "write_failed" };

const isLearningScope = (scope: string): scope is ImageStyleScope => (IMAGE_STYLE_SCOPES as readonly string[]).includes(scope);

/** The looks the brand record holds from before versions, by scope: non-empty words only. */
export function legacyLooksOf(tenant: Pick<Tenant, "brandKit" | "imageStyle"> | null | undefined): Partial<Record<ImageStyleScope, string>> {
  const out: Partial<Record<ImageStyleScope, string>> = {};
  const brand = tenant?.brandKit?.learnedImageStyle?.trim();
  if (brand) out[BRAND_SCOPE] = brand;
  for (const [styleId, learned] of Object.entries(tenant?.imageStyle?.learned ?? {})) {
    const words = learned?.directive?.trim();
    const id = canonicalStyleId(styleId);
    const scope = id ? `image_style.${id}` : null;
    if (words && scope && isLearningScope(scope) && !out[scope]) out[scope] = words;
  }
  return out;
}

/**
 * Seed the brand once: version 1 of every scope with a look from before versions, and `seededAt`.
 * Nothing happens with versions off or for a brand already seeded; a second seed at the same time
 * finds `seededAt` in its transaction, or fails on create(), and writes nothing.
 */
export async function seedBrand(ctx: TenantContext, tenant: Pick<Tenant, "brandKit" | "imageStyle"> | null, deps: SeedDeps = {}): Promise<SeedResult> {
  if (!isImageStyleVersionsOn()) return { ok: true, seeded: false, why: "switch" };
  const looks = legacyLooksOf(tenant);
  const scopes: ImageStyleScope[] = [];
  const refused: string[] = [];
  const words: Partial<Record<ImageStyleScope, string>> = {};
  for (const scope of IMAGE_STYLE_SCOPES) {
    const text = looks[scope];
    if (!text) continue;
    const checked = checkLookText(text);
    if (checked.ok) {
      words[scope] = checked.text;
      scopes.push(scope);
    } else refused.push(scope);
  }
  if (refused.length > 0) console.warn(`[loops] the seed left out ${refused.length} look(s) whose words the text check refuses`);

  const at = (deps.now ?? new Date()).toISOString();
  try {
    return await runLoopsTransaction(
      ctx,
      async (txn) => {
        const pointers = await readBrandPointersTx(txn, ctx, deps.db);
        if (pointers.seededAt) return { ok: true as const, seeded: false as const, why: "already" as const };
        const next: BrandPointers = { ...pointers, scopes: { ...pointers.scopes }, seededAt: at };
        for (const scope of scopes) {
          // A scope that already has a version (none should, as learning waits for the seed) keeps it.
          if ((pointers.scopes[scope]?.v ?? 0) > 0) continue;
          appendPatternVersionTx(
            txn,
            ctx,
            {
              channel: scope,
              version: 1,
              directive: null,
              perform: [],
              avoid: [],
              judgeRationale: "",
              evidence: [],
              createdBy: "seed",
              createdAt: at,
              loop: "image_style",
              setBy: "seeded",
              items: [{ id: "look1", type: "rule", text: words[scope]!, trust: "own_content", from: "seed" }],
              change: { op: "add", itemId: "look1" },
            },
            deps.db,
          );
          next.scopes[scope] = { v: 1, setBy: "seeded", adoptedAt: at };
        }
        writeBrandPointersTx(txn, ctx, next, deps.db);
        return { ok: true as const, seeded: true as const, scopes, refused };
      },
      deps.db,
    );
  } catch (err) {
    console.warn("[loops] seeding the brand's looks failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    // A racing seed may have won: that is a seeded brand, not a failure.
    const now = await readBrandPointers(ctx, deps.db).catch(() => null);
    if (now?.seededAt) return { ok: true, seeded: false, why: "already" };
    return { ok: false, error: "write_failed" };
  }
}
