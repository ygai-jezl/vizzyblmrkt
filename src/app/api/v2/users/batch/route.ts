import { handleBatch } from "@/lib/connect/v2/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** API v2: update up to 100 users' state, item by item. */
export async function POST(req: Request) {
  return handleBatch(req);
}
