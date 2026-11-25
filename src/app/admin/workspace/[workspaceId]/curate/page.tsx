import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Curate opens the Scrapbook (was the Idea Board; its route stays idea-board). */
export default async function CuratePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/admin/workspace/${workspaceId}/curate/idea-board`);
}
