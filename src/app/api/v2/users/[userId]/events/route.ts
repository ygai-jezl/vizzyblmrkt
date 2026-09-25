import { handleUserEvent } from "@/lib/connect/v2/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** API v2: record a milestone for one user. */
export async function POST(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  return handleUserEvent(req, (await params).userId);
}
