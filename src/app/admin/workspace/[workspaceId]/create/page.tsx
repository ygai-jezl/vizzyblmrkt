import { notFound } from "next/navigation";
import { isPageLanguagesEnabled } from "@/lib/i18n/flags";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { CreatePanel } from "@/components/admin/workspace/create/CreatePanel";
import { isBlogBrandMapEnabled } from "@/lib/content/blog/flags";
import { loadArticleMap } from "@/lib/content/blog/mapActions";
import { isNextUpEnabled } from "@/lib/autopilot/flags";
import { getRun } from "@/lib/autopilot/runs";
import { writeNextFrom } from "@/lib/content/blog/articleMap";
import { isBrandMapPagesEnabled, isBrandMapSituationsEnabled } from "@/lib/brandMap/flags";
import { isSuggestAngleEnabled } from "@/lib/content/create/flags";
import { isConnectorSignalsEnabled } from "@/lib/connectors/flags";
import type { NumbersPrefill } from "@/components/admin/workspace/create/CreateWizard";

export const dynamic = "force-dynamic";

/** Create pillar: list saved content workflows + the intake wizard for new ones. */
export default async function CreatePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  /**
   * `?question=q_…`: "Write this next" from the brand map (`&situation=sit_…`: from a buying situation).
   * `?numbers=page|search&text=…&hub=…`: Plan an article from a suggestion your numbers made.
   */
  searchParams: Promise<{ question?: string | string[]; situation?: string | string[]; run?: string | string[]; numbers?: string | string[]; text?: string | string[]; hub?: string | string[] }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const { question, situation, run, numbers, text, hub } = await searchParams;
  const situations = isBrandMapSituationsEnabled();
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
    // At any size, "Write this next"'s question is read by id (with its subject).
    isBlogBrandMapEnabled()
      ? loadArticleMap(
          ctx,
          {},
          typeof question === "string" ? { ask: { primaryRef: question, ...(situations && typeof situation === "string" ? { situationId: situation } : { situationId: null }) } } : {},
        ).catch(() => null)
      : null,
  ]);
  sources.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  // "Write this next": the wizard starts from the map question, while it is still on the map.
  const prefill = map && isBrandMapPagesEnabled() && typeof question === "string" ? writeNextFrom(map, question) : null;
  // From Next up's sort: what goes in the article, as What buyers ask (only the run's own question).
  const sorted = prefill && typeof run === "string" && /^run_[a-f0-9]{24}$/.test(run) && isNextUpEnabled() ? await getRun(ctx, run).catch(() => null) : null;
  const prefillAsks =
    sorted?.trays && sorted.question?.questionId === prefill?.questionId
      ? sorted.trays.use.map((i) => (i.kind === "also" ? `Also searched: ${i.text}` : i.text)).join("\n")
      : null;

  return (
    <CreatePanel
      workspaceId={workspaceId}
      initialPlans={plans}
      topics={ws.topics ?? []}
      initialSources={sources}
      subjects={(map?.subjects ?? []).map((s) => ({ id: s.id, name: s.name, questions: s.questions.map((q) => ({ id: q.id, text: q.text })) }))}
      subjectSearch={Boolean(map?.atScale)}
      prefill={prefill}
      prefillAsks={prefillAsks}
      situations={situations && Boolean(map?.atScale)}
      pageLanguages={isPageLanguagesEnabled()}
      prefillSituation={prefill && map?.situation ? { id: map.situation.id, text: map.situation.text } : null}
      prefillNumbers={prefill ? null : numbersPrefill(numbers, text, hub)}
      suggestAngle={isSuggestAngleEnabled()}
    />
  );
}

const oneLine = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Plan an article from a suggestion your numbers made (CONNECTOR_SIGNALS_ENABLED): what to fill in, or null. */
function numbersPrefill(kind: unknown, text: unknown, hub: unknown): NumbersPrefill | null {
  if (!isConnectorSignalsEnabled() || (kind !== "page" && kind !== "search")) return null;
  const words = oneLine(text, 200);
  if (!words || (kind === "page" && !words.startsWith("/"))) return null;
  const address = oneLine(hub, 300);
  return { kind, text: words, hub: kind === "page" && /^https:\/\/[^\s/]+\//.test(address) ? address : null };
}
