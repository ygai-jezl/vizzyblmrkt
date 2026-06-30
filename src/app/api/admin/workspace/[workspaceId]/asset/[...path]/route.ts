import { getAdminContext } from "@/lib/auth/session";
import { readWorkspaceAsset } from "@/lib/workspace/assetStore";
import { verifyWorkspace } from "@/lib/tenant/workspaceContent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTHENTICATED proxy for private Idea Board screenshots. The object key is always
 * reconstructed from the SESSION's tenantId, so a request can only ever read its
 * own tenant's assets. Filename is charset-validated in readWorkspaceAsset.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ workspaceId: string; path: string[] }> },
) {
  const ctx = await getAdminContext();
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  const { workspaceId, path } = await params;
  const filename = Array.isArray(path) && path.length === 1 ? path[0] : null;
  if (!filename) {
    return new Response("Not found", { status: 404 });
  }
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return new Response("Not found", { status: 404 });
  }
  const asset = await readWorkspaceAsset(ctx.tenantId, workspaceId, filename);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.bytes.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
