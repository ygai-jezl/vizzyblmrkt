import { handleMe } from "@/lib/connect/v2/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** API v2: the connection behind the key — check credentials, and that they're the right environment's. */
export async function GET(req: Request) {
  return handleMe(req);
}
