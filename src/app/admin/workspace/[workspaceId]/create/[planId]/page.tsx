import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant, getTenantById } from "@/lib/tenant";
import { headers } from "next/headers";
import { getContentPlan, listTemplates } from "@/lib/tenant/workspaceContent";
import { isEbookUiEnabled } from "@/lib/content/create/ebook";
import { getPrimaryLogo } from "@/lib/admin/brandLogos";
import { brandLogoAbsoluteUrl, isBrandKitLogosEnabled } from "@/lib/content/brandKit";
import { platformOrigin } from "@/lib/platform/origin";
import { originFromHeaders } from "@/lib/http/origin";
import { isEmailStyleEnabled } from "@/lib/email/flags";
import { resolveEmailStyle } from "@/lib/email/resolveEmailStyle";
import { resolveFooterBrand } from "@/lib/email/sender";
import { ContentCanvas } from "@/components/admin/workspace/create/ContentCanvas";
import { isBlogBrandMapEnabled, isBlogEditorialEnabled } from "@/lib/content/blog/flags";
import { isSeenOn, isSeenQuestionsOn, isSeenRestOn } from "@/lib/content/blog/hubActions";
import { refreshAnswers } from "@/lib/content/blog/seen";
import { askOfPlan, loadArticleMap } from "@/lib/content/blog/mapActions";
import { isBrandMapPagesEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";

export const dynamic = "force-dynamic";

/** Canvas for one content workflow — the Architect's graph, filled progressively. */
export default async function ContentPlanPage({
  params,
}: {
  params: Promise<{ workspaceId: string; planId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId, planId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();
  const planRead = getContentPlan(ctx, workspaceId, planId);
  const [plan, templates, emailPreview, brandMap] = await Promise.all([
    planRead,
    listTemplates(ctx, workspaceId),
    // The Email style and footer "sent by" newsletter previews wear, as the send does.
    // Flag off: no tenant read.
    isEmailStyleEnabled()
      ? getTenantById(ctx.tenantId)
          .then((tenant) => ({ style: resolveEmailStyle(tenant), footerBrand: resolveFooterBrand(tenant, null) }))
          .catch(() => null)
      : null,
    // The brand map a blog article is written from: its checklist and markup read it in the
    // browser. Flag off (or none saved): null, and the canvas is as before.
    // At any size, only the part of the map close to this article (read once the plan is).
    isBlogBrandMapEnabled()
      ? (isBrandMapScaleEnabled() ? planRead.then((p) => loadArticleMap(ctx, {}, p ? { ask: askOfPlan(p) } : {})) : loadArticleMap(ctx)).catch(() => null)
      : null,
  ]);
  if (!plan) notFound();
  // The answers to a blog article's questions are read live: one given on Brand › What we've seen shows here.
  const shown =
    plan.blog?.seen?.questions?.length && isSeenQuestionsOn()
      ? { ...plan, blog: await refreshAnswers(ctx, plan.blog, {}, `${workspaceId}/${planId}`).catch(() => plan.blog) }
      : plan;

  // An eBook that hasn't been finalized (no graph yet) has no canvas to show — send the
  // operator back into the authoring studio to resume (also covers a stale/bookmarked URL).
  if (isEbookUiEnabled() && plan.topology.hubChannel === "ebook" && plan.graph.nodes.length === 0) {
    redirect(`/admin/workspace/${workspaceId}/create/${planId}/ebook`);
  }

  const templateOptions = templates.map((t) => ({
    id: t.id,
    title: t.title,
    channel: t.channel ?? null,
    blockType: t.blockType ?? null,
    tier: t.tier ?? null,
    framework: t.framework ?? null,
  }));

  // The tenant's primary brand logo (ABSOLUTE public URL, so it loads in a real inbox)
  // defaults into new email-layout headers. Gated on the logos feature; fail-soft so a
  // lookup never blocks the canvas. Origin: the platform origin, else the request origin.
  let primaryLogoUrl: string | null = null;
  if (isBrandKitLogosEnabled()) {
    try {
      const logo = await getPrimaryLogo(ctx);
      if (logo) {
        const origin = platformOrigin() || originFromHeaders(await headers());
        primaryLogoUrl = brandLogoAbsoluteUrl(origin, ctx.tenantId, logo.filename);
      }
    } catch (err) {
      console.error("[create] primary logo lookup failed", err);
    }
  }

  return (
    <div className="space-y-3">
      <Link
        href={`/admin/workspace/${workspaceId}/create`}
        className="text-xs text-neutral-500 hover:underline"
      >
        ← All workflows
      </Link>
      <ContentCanvas
        // Remount only when Vizzy saves a new version (nav v2 phase 4), never on the operator's own saves.
        key={plan.agentRevision ?? 0}
        workspaceId={workspaceId}
        initial={shown}
        templates={templateOptions}
        brandName={ws.name}
        primaryLogoUrl={primaryLogoUrl}
        emailStyle={emailPreview?.style ?? null}
        footerBrand={emailPreview?.footerBrand ?? null}
        brandMap={plan.topology.hubChannel === "blog" ? brandMap : null}
        pagesOn={isBrandMapPagesEnabled()}
        editorialOn={isBlogEditorialEnabled()}
        seenOn={isSeenOn()}
        seenQuestionsOn={isSeenQuestionsOn()}
        seenRestOn={isSeenRestOn()}
      />
    </div>
  );
}
