import type { Firestore } from "firebase-admin/firestore";

/**
 * Update an ingestion_tickets doc with a tenant-ownership guard. The worker
 * receives tenantId/ticketId via trusted env (set by the dispatch route from a
 * verified admin context), but we still verify the stored tenantId matches before
 * writing — defence in depth against a misrouted execution.
 */
export async function updateTicket(
  db: Firestore,
  tenantId: string,
  ticketId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const ref = db.collection("ingestion_tickets").doc(ticketId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`ticket_not_found: ${ticketId}`);
  if (snap.data()?.tenantId !== tenantId) {
    throw new Error(`ticket_tenant_mismatch: ${ticketId}`);
  }
  await ref.update(patch);
}
