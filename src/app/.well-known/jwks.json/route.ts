import { publishedJwks } from "@/lib/connect/outboundSigner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public keys that verify the platform's requests to connected products
 * (context pulls, webhooks) — see src/lib/connect/outboundToken.ts. Public by
 * design: it holds nothing that can sign. Verifiers cache it per Cache-Control
 * and refetch when they meet an unknown kid; a new key is listed here a day
 * before it signs anything.
 */
export async function GET() {
  try {
    const keys = await publishedJwks();
    return Response.json(
      { keys },
      { headers: { "cache-control": "public, max-age=3600, stale-while-revalidate=600" } },
    );
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
