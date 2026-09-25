import { permanentRedirect } from "next/navigation";

/**
 * "Sending events" (API v1) became "Sending users" (API v2) when v1 was removed
 * on 2026-09-25. Links and prompts copied before then land on the new page.
 */
export default function EventsMoved(): never {
  permanentRedirect("/developers/users");
}
