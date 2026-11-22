import type { ConnectionView } from "@/lib/connectors/service";
import { callApi, ROUTES, startSignIn } from "./api";
import type { ApiCall } from "./tokenConnect";
import { CONNECTED_COPY, confirmDisconnectWords, connectionWords, disconnectedWords, pickPath, withGrant } from "./words";

/**
 * What the buttons on Connected do, apart from the page so the tests can run them with a stub
 * call. The panel stays on the connection acted on: every action selects it explicitly, whatever
 * its state turns out to be, so a Check that fixes one connection (or breaks another) never moves
 * the panel to whichever now needs attention. A Disconnect selects nothing, and its note says
 * which connection went and what to do at the tool.
 */

export type ConnectedNote = { tone: "ok" | "warn" | "err"; text: string } | null;

export interface ConnectedActionDeps {
  /** A route call; the page passes callApi. */
  call?: ApiCall;
  /** Start Sign in with Google again for a connection; the page passes startSignIn. */
  signIn?: typeof startSignIn;
  /** Put a connection's new state in the list. */
  replace: (view: ConnectionView) => void;
  /** Which connection the panel shows, or none. */
  select: (id: string | null) => void;
  note: (note: ConnectedNote) => void;
  /** The browser's confirm box. */
  confirm: (message: string) => boolean;
  /** Leave for another site (Google's sign in). */
  leave: (url: string) => void;
  /** Go to another page of the app (the picker). */
  push: (path: string) => void;
}

export function connectedActions(d: ConnectedActionDeps) {
  const call = d.call ?? callApi;
  const signIn = d.signIn ?? startSignIn;
  return {
    reconnect: async (c: ConnectionView) => {
      d.select(c.id);
      const r = await signIn(c.connectorId, c.id);
      if (r.ok) d.leave(r.data.url);
      else d.note({ tone: "err", text: r.message });
    },
    checkAccess: async (c: ConnectionView) => {
      d.select(c.id);
      const r = await call<{ connection: ConnectionView; visible: boolean; message: string | null }>(ROUTES.access(c.id), { method: "POST" });
      if (!r.ok) return d.note({ tone: r.status === 409 ? "warn" : "err", text: r.message });
      d.replace(r.data.connection);
      if (r.data.visible && r.data.connection.needsAccount) d.push(pickPath(c.connectorId, c.id));
      else d.note(r.data.visible ? { tone: "ok", text: CONNECTED_COPY.checkedOk } : { tone: "warn", text: r.data.message ?? CONNECTED_COPY.checkedOk });
    },
    check: async (c: ConnectionView) => {
      d.select(c.id);
      const r = await call<{ connection: ConnectionView; check: { ok: boolean; message: string | null } }>(ROUTES.check(c.id), { method: "POST" });
      if (!r.ok) return d.note({ tone: r.status === 409 ? "warn" : "err", text: r.message });
      d.replace(r.data.connection);
      d.note(r.data.check.ok ? { tone: "ok", text: CONNECTED_COPY.checkedOk } : { tone: "warn", text: r.data.check.message ?? CONNECTED_COPY.checkedOk });
    },
    pause: async (c: ConnectionView, paused: boolean) => {
      d.select(c.id);
      const r = await call<ConnectionView>(ROUTES.pause(c.id), { method: "POST", body: { paused } });
      if (!r.ok) return d.note({ tone: "err", text: r.message });
      d.replace(r.data);
    },
    grant: async (c: ConnectionView, to: "members" | "agent:vizzy", on: boolean) => {
      d.select(c.id);
      const r = await call<ConnectionView>(ROUTES.grants(c.id), { method: "PUT", body: { grants: withGrant(c.details?.grants ?? [], to, on) } });
      if (!r.ok) return d.note({ tone: "err", text: r.message });
      d.replace(r.data);
    },
    disconnect: async (c: ConnectionView) => {
      d.select(c.id);
      if (!d.confirm(confirmDisconnectWords(c))) return;
      const r = await call<{ connection: ConnectionView; message: string }>(ROUTES.connection(c.id), { method: "DELETE" });
      if (!r.ok) return d.note({ tone: "err", text: r.message });
      d.replace(r.data.connection);
      // It leaves the table, so the panel shows nothing rather than another connection's buttons.
      d.select(null);
      d.note({ tone: "ok", text: disconnectedWords(connectionWords(c), r.data.message) });
    },
  };
}

export type ConnectedActions = ReturnType<typeof connectedActions>;
