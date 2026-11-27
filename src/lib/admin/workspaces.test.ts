import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting a programme takes the approved examples of its plans with it, so nothing from a deleted
// programme keeps guiding the brand's email and hub writers.
const order: string[] = [];
const workspaces = vi.hoisted(() => ({ getById: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/tenant", () => ({
  forTenant: () => ({ workspaces, ingestionTickets: { find: vi.fn(async () => []), delete: vi.fn() } }),
  deleteOwnerKnowledge: vi.fn(async () => 0),
}));
vi.mock("@/lib/content/blog/pageActions", () => ({ removeWorkspacePages: vi.fn(async () => 0) }));
const examples = vi.hoisted(() => ({ forgetWorkspaceExamples: vi.fn() }));
vi.mock("@/lib/content/create/approvedExamples", () => examples);

const { deleteWorkspace } = await import("./workspaces");

const ctx = { tenantId: "ten_A", region: "eu", source: "idtoken", userId: "usr_1" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  workspaces.getById.mockResolvedValue({ id: "ws1", name: "Hearth Bakery" });
  workspaces.delete.mockImplementation(async () => void order.push("workspace"));
  examples.forgetWorkspaceExamples.mockImplementation(async () => (order.push("examples"), 2));
});

describe("deleting a programme", () => {
  it("forgets its plans' approved examples before the programme goes", async () => {
    expect(await deleteWorkspace(ctx, "ws1")).toBe(true);
    expect(examples.forgetWorkspaceExamples).toHaveBeenCalledWith(ctx, "ws1");
    expect(order).toEqual(["examples", "workspace"]);
  });

  it("forgets nothing for a programme that isn't there", async () => {
    workspaces.getById.mockResolvedValue(null);
    expect(await deleteWorkspace(ctx, "ws9")).toBe(false);
    expect(examples.forgetWorkspaceExamples).not.toHaveBeenCalled();
  });
});
