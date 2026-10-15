import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { CreatePanel } from "@/components/admin/workspace/create/CreatePanel";
import { isBlogBrandMapEnabled } from "@/lib/content/blog/flags";
import { loadArticleMap } from "@/lib/content/blog/mapActions";
import { writeNextFrom } from "@/lib/content/blog/articleMap";
import { isBrandMapPagesEnabled } from "@/lib/brandMap/flags";

export const dynamic = "force-dynamic";

/** Create pillar: list saved content workflows + the intake wizard for new ones. */
export default async function CreatePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  /** `?question=q_…`: "Write this next" from the brand map. */
  searchParams: Promise<{ question?: string | string[] }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const { question } = await searchParams;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();

  const [plans, sources, map] = await Promise.all([
    listContentPlans(ctx, workspaceId),
    forTenant(ctx).ingestionTickets.find({
      where: [
        ["ownerKind", "==", "workspace"],
        ["ownerId", "==", workspaceId],
      ],
      limit: 200,
    }),
    // The brand map's subjects, so a new article can be for one (null with its switch off or none saved).
    isBlogBrandMapEnabled() ? loadArticleMap(ctx).catch(() => null) : null,
  ]);
  sources.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  // "Write this next": the wizard starts from the map question, while it is still on the map.
  const prefill = map && isBrandMapPagesEnabled() && typeof question === "string" ? writeNextFrom(map, question) : null;

  return (
    <CreatePanel
      workspaceId={workspaceId}
      initialPlans={plans}
      topics={ws.topics ?? []}
      initialSources={sources}
      subjects={(map?.subjects ?? []).map((s) => ({ id: s.id, name: s.name, questions: s.questions.map((q) => ({ id: q.id, text: q.text })) }))}
      prefill={prefill}
    />
  );
}
