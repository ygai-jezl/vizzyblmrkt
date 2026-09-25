import { handleDeleteUser, handleGetUser, handlePatchUser } from "@/lib/connect/v2/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ userId: string }> };

/** API v2: update one user's state (JSON Merge Patch). */
export async function PATCH(req: Request, { params }: Params) {
  return handlePatchUser(req, (await params).userId);
}

/** API v2: what YouGrow holds for one user. */
export async function GET(req: Request, { params }: Params) {
  return handleGetUser(req, (await params).userId);
}

/** API v2: erase one user. Safe to repeat. */
export async function DELETE(req: Request, { params }: Params) {
  return handleDeleteUser(req, (await params).userId);
}
