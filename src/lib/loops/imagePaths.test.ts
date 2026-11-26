import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles, stripComments } from "@/lib/ontology/storeScan";
import { reasonProblems } from "./reason";
import { IMAGE_KINDS, type ImageKind } from "./read";

/**
 * Every image path reads what was learned (learning loops step 4, 3.6 of the plan for steps 4 and
 * 5). A file outside the image library modules that makes, stores or records an image must be in
 * this table: either it reads learnedFor for its kind (directly, or through makeBlogHero, which
 * reads it), or it handles only a person's own image, which YouGrow did not make. A new image
 * route fails here until it reads learnedFor or says why it doesn't.
 *
 * Plain text scans of the source, comments left out.
 */

const ROOT = process.cwd();
const FILES = sourceFiles("src", ROOT).map((file) => ({ file, code: stripComments(readFileSync(join(ROOT, file), "utf8")) }));
const codeOf = (file: string) => FILES.find((f) => f.file === file)?.code ?? "";

/** The calls that make, store or record an image. */
const MAKES_IMAGE =
  /\b(?:generateSocialPostImage|generateEbookSlotImage|generateEmailBlockImage|generateHeroImage|customizeImageAsset|makeBlogHero|heroFromUpload|buildCarousel|recordImageAsset|storeWorkspaceImage|storeEmailImage|paintFormatScene|generateImage|generateBlockImage|generateEbookImage|generateImageWithDeadline|generateSlideImage)\(/;

const API = "src/app/api/admin";
const PLAN = `${API}/workspace/[workspaceId]/content-plans/[planId]`;

type Path =
  | { kind: ImageKind; reads: "learnedFor" | "makeBlogHero"; what: string }
  | { own: string };

/** The image paths of 3.6, by the file that runs each one. */
const PATHS: Record<string, Path> = {
  [`${PLAN}/nodes/[nodeId]/post-image/route.ts`]: { kind: "post_image", reads: "learnedFor", what: "A post's image: painted with the look, or drawn, a format or a chart with arm none." },
  "src/lib/content/blog/hero.ts": { kind: "blog_hero", reads: "learnedFor", what: "A blog article's hero, made by the article card and by Vizzy's canvas." },
  [`${PLAN}/nodes/[nodeId]/blog/hero/route.ts`]: { kind: "blog_hero", reads: "makeBlogHero", what: "The article card's Make and Make again." },
  "src/lib/canvas/kinds/contentPlan.ts": { kind: "blog_hero", reads: "makeBlogHero", what: "The hero Vizzy makes with a content plan, with the brand context once versions are on." },
  [`${API}/email/image/route.ts`]: { kind: "email_hero", reads: "learnedFor", what: "A launch email's hero, whose stamp goes back to the browser as a token." },
  [`${PLAN}/nodes/[nodeId]/image/route.ts`]: { kind: "email_block_image", reads: "learnedFor", what: "An image in an email layout block." },
  [`${PLAN}/ebook/images/route.ts`]: { kind: "ebook_image", reads: "learnedFor", what: "An eBook slot or cover, or the drawn report cover with arm none." },
  [`${API}/brand-kit/images/[assetId]/customize/route.ts`]: { kind: "customize_image", reads: "learnedFor", what: "Customise, whose none line gives arm none with no read." },
  [`${API}/workspace/[workspaceId]/distribute/carousel/route.ts`]: { kind: "carousel", reads: "learnedFor", what: "A carousel, whose none line gives arm none, counted once per carousel." },
  [`${API}/brand-kit/images/upload/route.ts`]: { own: "A photo a person uploads to the library is their own: it is stamped own_image, counted as a like and profiled." },
  [`${PLAN}/nodes/[nodeId]/post-image/upload/route.ts`]: { own: "A person's own photo for a post is stored as they gave it, with no library row." },
  [`${PLAN}/nodes/[nodeId]/blog/hero/upload/route.ts`]: { own: "A person's own photo as an article's hero is cropped and stored, with no library row." },
  [`${PLAN}/ebook/images/upload/route.ts`]: { own: "A person's own photo in an eBook is stored as they gave it, with no library row." },
  [`${API}/workspace/[workspaceId]/idea-items/route.ts`]: { own: "A screenshot a person adds to an idea is stored as they gave it, with no library row." },
};

/** Where a path reads learnedFor for its kind, however the call is laid out. */
const readsFor = (kind: string) => new RegExp(`\\blearnedFor\\(\\s*ctx,\\s*"${kind}"`);

/** The library modules that make images for the paths above, which never pick a look themselves. */
const LIBRARY: Record<string, string> = {
  "src/lib/agents/creative.ts": "It makes each path's image with the brand context and the learning its caller read, and settles the stamp where the image is made.",
  "src/lib/agents/gemini.ts": "It calls the image models and knows nothing of brands or looks.",
  "src/lib/agents/imageStore.ts": "It stores an email image's bytes for the paths that made it.",
  "src/lib/admin/brandKit.ts": "It records an image row with the stamp its caller gives, which every writer must pass.",
  "src/lib/workspace/assetStore.ts": "It stores an image's bytes for the paths that made it.",
  "src/lib/content/imageStyle/formatScene.ts": "It paints a format's scene for the post and hero paths, which stamp formats with arm none.",
  "src/lib/distribute/carousel/build.ts": "It paints a carousel's slides for the carousel route, whose none line never learns.",
};

const outsideLibrary = FILES.filter((f) => MAKES_IMAGE.test(f.code) && !(f.file in LIBRARY) && !f.file.startsWith("src/components/"));

describe("every image path reads what was learned", () => {
  it("lists every file that makes, stores or records an image, outside the library modules", () => {
    const found = outsideLibrary.map((f) => f.file).filter((f) => !(f in PATHS));
    expect(found, "a new image path: read learnedFor for its kind and add it to PATHS, or say why it is a person's own image").toEqual([]);
  });

  it("reads learnedFor on every path YouGrow makes an image on", () => {
    for (const [file, path] of Object.entries(PATHS)) {
      const code = codeOf(file);
      expect(code.length, `${file} is gone: take it off PATHS`).toBeGreaterThan(0);
      if ("own" in path) {
        expect(reasonProblems(path.own), file).toEqual([]);
        expect(code, `${file} handles a person's own image and reads no look`).not.toMatch(/\blearnedFor\(/);
        continue;
      }
      expect(IMAGE_KINDS as readonly string[], file).toContain(path.kind);
      expect(reasonProblems(path.what), file).toEqual([]);
      if (path.reads === "learnedFor") {
        expect(code, `${file} reads learnedFor for ${path.kind}`).toMatch(readsFor(path.kind));
      } else {
        expect(code, file).toMatch(/\bmakeBlogHero\b/);
        expect(codeOf("src/lib/content/blog/hero.ts"), "makeBlogHero reads learnedFor").toMatch(readsFor("blog_hero"));
      }
    }
  });

  it("stamps every row an image path records, as recordImageAsset requires", () => {
    for (const [file] of Object.entries(PATHS)) {
      const code = codeOf(file);
      const records = code.match(/\brecordImageAsset\(/g)?.length ?? 0;
      if (records === 0) continue;
      expect(code, `${file} records an image row with its stamp`).toMatch(/\bmade(?::|,|\s*\})/);
    }
  });

  it("covers every image kind the registry knows", () => {
    const kinds = new Set(Object.values(PATHS).flatMap((p) => ("kind" in p ? [p.kind] : [])));
    expect([...kinds].sort()).toEqual([...IMAGE_KINDS].sort());
  });

  it("keeps each library module's reason plain", () => {
    for (const [file, why] of Object.entries(LIBRARY)) {
      expect(codeOf(file).length, `${file} is gone: take it off LIBRARY`).toBeGreaterThan(0);
      expect(reasonProblems(why), file).toEqual([]);
    }
  });
});
