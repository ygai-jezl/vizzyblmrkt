import {
  handleCreateSiteKey,
  handleGetSiteKey,
  handlePatchSiteKey,
  handleRevokeSiteKey,
} from "@/lib/waitlist/siteKeyAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ campaignId: string }> };

/** The launch's site key (never its secret) and the address to call. */
export async function GET(req: Request, { params }: Params) {
  return handleGetSiteKey(req, (await params).campaignId);
}

/** Create site key: the secret comes back this once. */
export async function POST(req: Request, { params }: Params) {
  return handleCreateSiteKey(req, (await params).campaignId);
}

/** Send them to: where people land after confirming. */
export async function PATCH(req: Request, { params }: Params) {
  return handlePatchSiteKey(req, (await params).campaignId);
}

/** Revoke key. */
export async function DELETE(req: Request, { params }: Params) {
  return handleRevokeSiteKey(req, (await params).campaignId);
}
