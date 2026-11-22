import type { ConnectionsScreen } from "@/lib/connectors/screens";
import { NOTE_ERR, NOTE_PLAIN, SCREEN_COPY } from "./words";

/**
 * What a Connections screen shows instead of itself: the core switch is off (every connector route
 * answers 404), or the list didn't load. Null when the screen can show.
 */
export function ScreenUnavailable({ screen }: { screen: Pick<ConnectionsScreen, "core" | "failed"> }) {
  if (!screen.core) return <p className={NOTE_PLAIN}>{SCREEN_COPY.coreOff}</p>;
  if (screen.failed) return <p className={NOTE_ERR}>{SCREEN_COPY.failed}</p>;
  return null;
}
