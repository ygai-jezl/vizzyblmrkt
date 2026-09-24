import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { exportJourney } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download the journey's design as a portable JSON document (?which=published,
 * the default, or ?which=draft). Carries no people, recipients or account ids.
 */
export async function GET(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false, journeys: true });
  if (!gate.ok) return gate.response;
  const which = new URL(req.url).searchParams.get("which") === "draft" ? "draft" : "published";
  const r = await exportJourney(gate.ctx, (await params).journeyId, which);
  if (r.status !== 200) return respond(r);
  const doc = r.body as { name: string };
  const slug = doc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "journey";
  return new Response(JSON.stringify(r.body, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${slug}.journey.json"`,
      "cache-control": "no-store",
    },
  });
}
