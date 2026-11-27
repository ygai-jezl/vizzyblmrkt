import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// New idea, opened from Work's Make it an idea: while WORK_ENABLED, ?name= fills the name and
// ?task= names the task to link once the idea is made, in the session brand. Made-up Lumen Notes.
const state = vi.hoisted(() => ({ ctx: { tenantId: "ten_lumen", region: "us", source: "idtoken", userId: "uid_nina", role: "admin" } }));
vi.mock("@/lib/auth/session", () => ({ requireAdminContext: async () => state.ctx }));
const { default: NewLaunchPage } = await import("./page");
const { NewLaunchForm } = await import("@/components/admin/NewLaunchForm");

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: ReactNode };
}
const isEl = (n: unknown): n is El => typeof n === "object" && n !== null && "type" in n && "props" in n;
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  if (!isEl(node)) return out;
  out.push(node);
  elements(node.props.children, out);
  return out;
}
const formProps = async (sp?: Record<string, string>) =>
  elements(await NewLaunchPage(sp ? { searchParams: Promise.resolve(sp) } : {})).find((e) => e.type === NewLaunchForm)!.props;

beforeEach(() => vi.stubEnv("WORK_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("New idea from a Work task", () => {
  it("fills the name and links the task in this brand", async () => {
    expect(await formProps({ name: "  Team   spaces ", task: "12" })).toMatchObject({ initialName: "Team spaces", workTask: { ref: 12, brandId: "ten_lumen" } });
  });

  it("links nothing for a ref that isn't one, and with Work off opens exactly as before: empty, whatever the address says", async () => {
    expect((await formProps({ name: "Team spaces", task: "12; drop" })).workTask).toBeNull();
    vi.stubEnv("WORK_ENABLED", "");
    expect(await formProps({ name: "Team spaces", task: "12" })).toMatchObject({ initialName: "", workTask: null });
    expect(await formProps()).toMatchObject({ initialName: "", workTask: null });
  });
});
