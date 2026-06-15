import { NextResponse } from "next/server";
import { seedDemoData } from "@/lib/dev/seedDemo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DEV-ONLY seed endpoint. Hard-guarded:
 *   - 404 unless ALLOW_SEED === "true" (off by default → inert in prod builds)
 *   - 403 on any *-prod project
 *   - 403 unless x-seed-secret matches SEED_SECRET (when that env is set)
 * Idempotent. For local/CLI seeding prefer `npm run seed` (no endpoint needed).
 */
export async function POST(req: Request) {
  if (process.env.ALLOW_SEED !== "true") {
    return new NextResponse("Not found", { status: 404 });
  }
  if ((process.env.GOOGLE_CLOUD_PROJECT ?? "").endsWith("-prod")) {
    return NextResponse.json({ error: "seeding disabled on prod" }, { status: 403 });
  }
  const secret = process.env.SEED_SECRET;
  if (secret && req.headers.get("x-seed-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await seedDemoData();
  return NextResponse.json({ ok: true, ...result });
}
