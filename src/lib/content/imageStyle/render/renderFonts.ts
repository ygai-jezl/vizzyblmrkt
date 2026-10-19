import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant, TextStyleRole } from "@/lib/types/tenant";
import type { BrandFont } from "@/lib/types/brandFont";
import { listBrandFonts } from "@/lib/admin/brandFonts";
import { readBrandFont } from "@/lib/tenant/brandFontStore";
import { setTenantSiteFonts } from "@/lib/tenant/control";
import { detectSiteFonts, freeMatchFor } from "@/lib/content/create/fontsFromWebsite";
import { isSiteFontsEnabled } from "../flags";
import { renderableFilename } from "../fontRows";
import { ensureFontInspected } from "./fonts";
import { googleFontTtf } from "./googleFonts";
import { missingCharacters } from "./sfntInfo";
import { toFontWeight, type RenderFont } from "./render";

/**
 * The fonts an image is drawn with, per role (headings, body). The first that exists and can
 * draw every character of the text wins:
 *  1. the brand's uploaded font for that role (Brand › Fonts text styles name it; one uploaded
 *     family serves both roles);
 *  2. the family the text styles name, or the one found on the website, fetched free from
 *     Google Fonts (paid families become their closest free match); needs the site fonts switch;
 *  3. the bundled open-licence fonts (Inter; Lora for a serif brand).
 * The bundled Inter is always loaded last, so a missing character still draws.
 */

export interface FontPlan {
  fonts: RenderFont[];
  heading: string;
  body: string;
  /** Neither role found a brand font (the hero notes it). */
  bundledOnly: boolean;
}

type Role = "heading" | "body";
const ROLE_STYLES: Record<Role, TextStyleRole[]> = {
  heading: ["title", "heading", "subtitle"],
  body: ["body", "subheading", "caption"],
};
const WANT: Record<Role, 400 | 700> = { heading: 700, body: 400 };

// ── bundled ────────────────────────────────────────────────────────────────────────────────────

const BUNDLED_FILES = {
  "Inter-400": "inter-400.v1.woff",
  "Inter-700": "inter-700.v1.woff",
  "Lora-400": "lora-400.v1.woff",
  "Lora-700": "lora-700.v1.woff",
} as const;
const bundledCache = new Map<string, Buffer>();

async function bundled(family: "Inter" | "Lora", weight: 400 | 700): Promise<Buffer> {
  const key = `${family}-${weight}` as keyof typeof BUNDLED_FILES;
  const hit = bundledCache.get(key);
  if (hit) return hit;
  const bytes = await readFile(join(process.cwd(), "public", "email-fonts", BUNDLED_FILES[key]));
  bundledCache.set(key, bytes);
  return bytes;
}

/** Just the bundled fonts: the title card, which must never fail. */
export async function bundledFontPlan(): Promise<FontPlan> {
  return {
    fonts: [
      { name: "Inter", data: await bundled("Inter", 700), weight: 700, style: "normal" },
      { name: "Inter", data: await bundled("Inter", 400), weight: 400, style: "normal" },
    ],
    heading: "Inter",
    body: "Inter",
    bundledOnly: true,
  };
}

// ── the chain ──────────────────────────────────────────────────────────────────────────────────

function roleFamily(tenant: Tenant | null, role: Role): string | null {
  const styles = tenant?.brandTypography?.styles ?? [];
  for (const r of ROLE_STYLES[role]) {
    const fam = styles.find((s) => s.role === r)?.fontFamily?.trim();
    if (fam && fam.toLowerCase() !== "system") return fam;
  }
  return null;
}

function bestFile(fonts: BrandFont[], weight: number): BrandFont | null {
  const usable = fonts.filter((f) => renderableFilename(f));
  if (!usable.length) return null;
  const score = (f: BrandFont) => (f.italic ? 1000 : 0) + Math.abs((f.weight ?? 400) - weight);
  return [...usable].sort((a, b) => score(a) - score(b))[0]!;
}

const draws = (bytes: Buffer, text: string) => missingCharacters(bytes, text)?.length === 0;

/** Site fonts are read once per tenant per hour at most when nothing is saved yet. */
const detectTried = new Map<string, number>();

async function siteFontsOf(tenant: Tenant | null) {
  const saved = tenant?.imageStyle?.siteFonts;
  if (saved || !tenant?.rootDomain || !isSiteFontsEnabled()) return saved ?? null;
  const last = detectTried.get(tenant.id) ?? 0;
  if (Date.now() - last < 60 * 60 * 1000) return null;
  detectTried.set(tenant.id, Date.now());
  const found = await detectSiteFonts(tenant.rootDomain).catch(() => null);
  if (found) await setTenantSiteFonts(tenant.id, found).catch(() => {});
  return found;
}

export async function fontsForRender(input: {
  ctx: TenantContext;
  tenant: Tenant | null;
  /** Every character the image will draw. */
  text: string;
}): Promise<FontPlan> {
  const { ctx, tenant, text } = input;
  let uploads: BrandFont[] = [];
  try {
    uploads = await listBrandFonts(ctx);
    const unread = uploads.filter((f) => !f.inspectedAt).slice(0, 5);
    if (unread.length) {
      const read = await Promise.all(unread.map((f) => ensureFontInspected(ctx, f).catch(() => f)));
      uploads = uploads.map((f) => read.find((r) => r.id === f.id) ?? f);
    }
  } catch {
    uploads = [];
  }
  const families = [...new Set(uploads.map((f) => f.family.toLowerCase()))];
  const site = await siteFontsOf(tenant);
  const fonts: RenderFont[] = [];
  const chosen: Record<Role, string | null> = { heading: null, body: null };

  for (const role of ["heading", "body"] as const) {
    const named = roleFamily(tenant, role);
    const name = `Brand ${role}`;

    // 1. An uploaded font for this role.
    const uploadFamily = named && families.includes(named.toLowerCase()) ? named.toLowerCase() : families.length === 1 ? families[0]! : null;
    if (uploadFamily) {
      const file = bestFile(uploads.filter((f) => f.family.toLowerCase() === uploadFamily), WANT[role]);
      const filename = file ? renderableFilename(file) : null;
      const bytes = filename ? (await readBrandFont(ctx.tenantId, filename).catch(() => null))?.bytes : null;
      if (file && bytes && draws(bytes, text)) {
        fonts.push({ name, data: bytes, weight: toFontWeight(file.weight), style: "normal" });
        chosen[role] = name;
        continue;
      }
    }

    // 2. A free Google family: the one the text styles name, else the one found on the site.
    if (isSiteFontsEnabled()) {
      const candidates: string[] = [];
      if (named && !families.includes(named.toLowerCase())) candidates.push(freeMatchFor(named)?.family ?? named);
      const fromSite = site?.[role]?.family ?? site?.body?.family ?? site?.heading?.family;
      if (fromSite) candidates.push(fromSite);
      for (const fam of [...new Set(candidates)]) {
        const bytes = await googleFontTtf(fam, WANT[role]);
        if (bytes && draws(bytes, text)) {
          fonts.push({ name, data: bytes, weight: WANT[role], style: "normal" });
          chosen[role] = name;
          break;
        }
      }
      if (chosen[role]) continue;
    }
  }

  // 3. Bundled: Lora when the brand reads as serif, else Inter. Inter always goes last.
  const serif = /serif|lora|garamond|baskerville|caslon|playfair|merriweather|georgia|times/i;
  const wantsSerif = (role: Role) => !!roleFamily(tenant, role)?.match(serif) && !/sans/i.test(roleFamily(tenant, role)!);
  for (const role of ["heading", "body"] as const) {
    if (chosen[role]) continue;
    const family = wantsSerif(role) ? "Lora" : "Inter";
    fonts.push({ name: `Bundled ${family}`, data: await bundled(family, WANT[role]), weight: WANT[role], style: "normal" });
    chosen[role] = `Bundled ${family}`;
  }
  const plan = await bundledFontPlan();
  fonts.push(...plan.fonts);

  // One entry per name and weight.
  const seen = new Set<string>();
  const unique = fonts.filter((f) => {
    const k = `${f.name}:${f.weight}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    fonts: unique,
    heading: chosen.heading!,
    body: chosen.body!,
    bundledOnly: chosen.heading!.startsWith("Bundled") && chosen.body!.startsWith("Bundled"),
  };
}
