import { patchFieldValues } from "@/lib/audience/fieldValueRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Set some of one company's field values (AUDIENCE_FIELDS_ENABLED). Admins only. */
export async function PATCH(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  return patchFieldValues(req, "company", companyId);
}
