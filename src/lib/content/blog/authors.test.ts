import { afterEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BlogBriefSchema } from "@/lib/types/contentPlan";
import { authorDocId, rememberAuthor, withRememberedAuthor } from "./authors";

afterEach(() => vi.unstubAllEnvs());

const ctx = { tenantId: "ten_a", region: "us" } as TenantContext;
const other = { tenantId: "ten_b", region: "us" } as TenantContext;
const on = () => {
  vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
  vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "true");
};
const full = BlogBriefSchema.parse({ author: "Ana Ruiz", authorRole: "Head of Growth", authorBio: "Ana leads growth.", authorUrl: "https://acme.example/ana" });

describe("an author's details, kept for their next article", () => {
  it("are filled into empty fields only, for the same name in the same brand", async () => {
    on();
    const db = new FakeFirestore();
    await rememberAuthor(ctx, full, db);
    const next = await withRememberedAuthor(ctx, BlogBriefSchema.parse({ author: " ana  ruiz ", authorRole: "Founder" }), db);
    expect([next.authorRole, next.authorBio, next.authorUrl]).toEqual(["Founder", "Ana leads growth.", "https://acme.example/ana"]);
    // Another brand never sees them.
    const theirs = await withRememberedAuthor(other, BlogBriefSchema.parse({ author: "Ana Ruiz" }), db);
    expect(theirs.authorBio).toBeUndefined();
  });

  it("are not kept or read with the switch off, nor kept without anything to keep", async () => {
    const db = new FakeFirestore();
    await rememberAuthor(ctx, full, db);
    on();
    expect((await withRememberedAuthor(ctx, BlogBriefSchema.parse({ author: "Ana Ruiz" }), db)).authorBio).toBeUndefined();
    await rememberAuthor(ctx, BlogBriefSchema.parse({ author: "Bo" }), db);
    expect(await forTenant(ctx, db).brandAuthors.getById(authorDocId("ten_a", "Bo"))).toBeNull();
  });
});
