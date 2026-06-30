import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Curate defaults to the Idea Board (the brain-dump). */
export default async function CuratePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/admin/workspace/${workspaceId}/curate/idea-board`);
}
