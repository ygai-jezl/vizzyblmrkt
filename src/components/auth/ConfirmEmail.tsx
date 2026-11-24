"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { accessDeniedMessage, WORKSPACE_NOT_SET_UP_MESSAGE } from "@/lib/auth/accessDenied";
import { mintSession, mustSignOut, type MintResult } from "@/lib/auth/clientSession";
import { getClientAuth } from "@/lib/auth/firebaseClient";
import { AUTH_LABELS, AUTH_MESSAGES } from "@/lib/auth/messages";
import {
  afterSignInPath,
  authErrorMessage,
  checkEmailLink,
  looksLikeEmail,
  readConfirmLink,
  startPasswordBotChecks,
  type CheckLinkResult,
  type ConfirmLink,
} from "@/lib/auth/passwordClient";
import { AuthCard, EmailField, LINK_CLASS, LiveRegion, Messages, PasswordField, PrimaryButton, PRIMARY_BUTTON_CLASS, useHydrated } from "./parts";
import { SignInAgainView } from "./views";

/**
 * Where the page is:
 *  - checking       reading the link, waiting for the browser's sign-in, or confirming
 *  - sign_in        this browser isn't signed in with a password: email and password first.
 *                   `busy` while the typed password is being tried, so the form can never come
 *                   back disabled: each new sign_in phase starts with it off
 *  - retry          a failure that can be tried again (offline, a busy server)
 *  - stopped        nothing more to do here, with a way back to /login
 *  - sign_in_again  the door removed the account (the browser is signed out already)
 *  - leaving        confirmed and signed in: on the way to the admin home
 */
export type ConfirmPhase =
  | { kind: "checking" }
  | { kind: "sign_in"; busy?: true }
  | { kind: "retry"; message: string }
  | { kind: "stopped"; message: string }
  | { kind: "sign_in_again" }
  | { kind: "leaving" };

const hasPassword = (user: User) => user.providerData.some((p) => p.providerId === "password");

/**
 * Reads the link's token from the fragment, then takes the fragment out of the address bar and
 * history at once, whatever it holds and whether or not the switch is on, so the token isn't kept
 * in history, shared or bookmarked.
 */
export function takeConfirmLink(win: { location: Pick<Location, "hash" | "pathname">; history: Pick<History, "replaceState"> }): ConfirmLink {
  const link = readConfirmLink(win.location.hash);
  win.history.replaceState(null, "", win.location.pathname);
  return link;
}

/**
 * A second link pasted into this tab is a navigation within the page: nothing reloads, and the
 * page has read its link already. Reload when the address bar gets a fragment again, so the new
 * link is read and taken out of the address bar and history like the first. Returns the cleanup.
 */
export function reloadOnNewLink(win: {
  location: Pick<Location, "hash" | "reload">;
  addEventListener: (type: "hashchange", listener: () => void) => void;
  removeEventListener: (type: "hashchange", listener: () => void) => void;
}): () => void {
  const onHash = () => {
    if (win.location.hash.length > 1) win.location.reload();
  };
  win.addEventListener("hashchange", onHash);
  return () => win.removeEventListener("hashchange", onHash);
}

/** Why the page can't use what it took from the address bar. */
export function confirmLinkStop(link: Exclude<ConfirmLink, { kind: "link" }>): ConfirmPhase {
  return { kind: "stopped", message: link.kind === "empty" ? AUTH_MESSAGES.linkReopen : AUTH_MESSAGES.linkInvalid };
}

/** What the page does after the server refused the link. */
export function linkCheckPhase(result: Exclude<CheckLinkResult, { kind: "ok" }>): ConfirmPhase {
  switch (result.kind) {
    case "invalid":
      return { kind: "stopped", message: AUTH_MESSAGES.linkInvalid };
    case "sign_in":
      return { kind: "sign_in" };
    case "rate_limited":
      return { kind: "retry", message: AUTH_MESSAGES.tooManyTriesWait };
    case "unavailable":
      return { kind: "stopped", message: AUTH_MESSAGES.passwordUnavailable };
    case "error":
      return { kind: "retry", message: AUTH_MESSAGES.somethingWentWrong };
  }
}

/** What the page does with the door's answer once the link confirmed the account (as PasswordLogin does). */
export function mintPhase(result: MintResult): ConfirmPhase {
  switch (result) {
    case "ok":
      return { kind: "leaving" };
    case "forbidden":
      return { kind: "stopped", message: accessDeniedMessage() };
    case "not_set_up":
      return { kind: "stopped", message: WORKSPACE_NOT_SET_UP_MESSAGE };
    case "google_only":
      return { kind: "stopped", message: AUTH_MESSAGES.googleOnly };
    case "sign_in_again":
      return { kind: "sign_in_again" };
    // Only a Google sign-in is moved to a renamed address, never this page's password sign-in.
    case "address_updated":
      return { kind: "stopped", message: AUTH_MESSAGES.googleAddressChanged };
    // Just confirmed, yet still unconfirmed at the door: try the door again, never the link.
    case "email_not_verified":
    default:
      return { kind: "retry", message: AUTH_MESSAGES.somethingWentWrong };
  }
}

/**
 * Where the emailed link lands (/login/confirm#t=...), in place of a code once the address is
 * locked. The token leaves the address bar before anything else happens and lives only in this
 * page's memory. The link works only for the account it was sent for, so the browser must be
 * signed in to it with a password: if it isn't, the page asks for the email and password first.
 * Then the server confirms the account, a fresh token carries that to the door, and the door's
 * answer is handled as on /login.
 */
export function ConfirmEmail({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<ConfirmPhase>(enabled ? { kind: "checking" } : { kind: "stopped", message: AUTH_MESSAGES.passwordSigninOff });
  const token = useRef<string | null>(null);
  // The account whose link was accepted: the server deletes a used link, so a retry after the
  // door failed must not open it again (it would answer link_invalid for a confirmed account).
  const accepted = useRef<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const link = takeConfirmLink(window);
    if (!enabled) return;
    if (link.kind !== "link") return setPhase(confirmLinkStop(link));
    token.current = link.token;
    let auth: ReturnType<typeof getClientAuth>;
    try {
      auth = getClientAuth();
      startPasswordBotChecks(auth);
    } catch {
      return setPhase({ kind: "stopped", message: AUTH_MESSAGES.passwordUnavailable });
    }
    // Only the first answer matters: whether this browser was already signed in.
    let done = false;
    let stop: (() => void) | null = null;
    stop = onAuthStateChanged(auth, (user) => {
      if (done) return;
      done = true;
      stop?.();
      if (user && hasPassword(user)) void confirmWith(user);
      else setPhase({ kind: "sign_in" });
    });
    if (done) stop();
    // confirmWith only uses refs and setters; the effect runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => reloadOnNewLink(window), []);

  return <ConfirmEmailView phase={phase} onSignIn={signIn} onRetry={retry} onContinue={() => router.push("/login")} />;

  /** Opens the link for this account (once), then hands the account to the door. */
  async function confirmWith(user: User): Promise<void> {
    setPhase({ kind: "checking" });
    try {
      if (accepted.current !== user.uid) {
        const link = token.current;
        if (!link) return setPhase({ kind: "stopped", message: AUTH_MESSAGES.linkReopen });
        const result = await checkEmailLink(await user.getIdToken(), link);
        if (result.kind !== "ok") {
          if (result.kind === "invalid") token.current = null;
          return setPhase(linkCheckPhase(result));
        }
        accepted.current = user.uid;
        token.current = null;
      }
      // The link marked the account confirmed; a fresh token carries that to the door.
      await user.getIdToken(true);
      const minted = await mintSession(user);
      if (mustSignOut(minted)) await signOut(getClientAuth()).catch(() => undefined);
      const next = mintPhase(minted);
      setPhase(next);
      if (next.kind === "leaving") {
        router.push(afterSignInPath(""));
        router.refresh();
      }
    } catch {
      setPhase({ kind: "retry", message: AUTH_MESSAGES.somethingWentWrong });
    }
  }

  function retry() {
    let user: User | null = null;
    try {
      user = getClientAuth().currentUser;
    } catch {
      user = null;
    }
    if (user && hasPassword(user)) void confirmWith(user);
    else setPhase({ kind: "sign_in" });
  }

  /** Signs in with the password, then opens the link. Answers an error message, or null once signed in. */
  async function signIn(email: string, password: string): Promise<string | null> {
    if (!looksLikeEmail(email)) return AUTH_MESSAGES.emailLooksWrong;
    if (!password) return AUTH_MESSAGES.passwordMissing;
    setPhase({ kind: "sign_in", busy: true });
    let user: User;
    try {
      user = (await signInWithEmailAndPassword(getClientAuth(), email.trim(), password)).user;
    } catch (err) {
      setPhase({ kind: "sign_in" });
      return authErrorMessage(err, "sign_in") ?? AUTH_MESSAGES.somethingWentWrong;
    }
    void confirmWith(user);
    return null;
  }
}

/** What the page's live region says in each phase. */
function confirmLiveMessage(phase: ConfirmPhase, error: string | null): string {
  switch (phase.kind) {
    case "checking":
      return AUTH_LABELS.confirming;
    case "sign_in":
      return error ?? AUTH_MESSAGES.confirmSignIn;
    case "retry":
    case "stopped":
      return phase.message;
    case "sign_in_again":
      return AUTH_MESSAGES.signInAgainBody;
    case "leaving":
      return AUTH_LABELS.signingIn;
  }
}

/**
 * The screens, from the phase only. onSignIn answers with an error message, or null once signed
 * in. One live region outside the screens reads out each phase's message as it arrives.
 */
export function ConfirmEmailView({
  phase,
  onSignIn,
  onRetry = () => {},
  onContinue = () => {},
}: {
  phase: ConfirmPhase;
  onSignIn: (email: string, password: string) => Promise<string | null>;
  onRetry?: () => void;
  onContinue?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ConfirmScreen phase={phase} onSignIn={onSignIn} onRetry={onRetry} onContinue={onContinue} error={error} setError={setError} />
      <LiveRegion message={confirmLiveMessage(phase, error)} />
    </>
  );
}

function BackToSignIn() {
  return (
    <p className="text-center text-sm">
      <a href="/login" className={LINK_CLASS}>
        {AUTH_LABELS.backToSignIn}
      </a>
    </p>
  );
}

function ConfirmScreen({
  phase,
  onSignIn,
  onRetry,
  onContinue,
  error,
  setError,
}: {
  phase: ConfirmPhase;
  onSignIn: (email: string, password: string) => Promise<string | null>;
  onRetry: () => void;
  onContinue: () => void;
  error: string | null;
  setError: (message: string | null) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const hydrated = useHydrated();
  // From the phase, not this screen's own state: the screen stays mounted across phases, so a
  // flag of its own would still be on when the page comes back to sign in.
  const busy = phase.kind === "sign_in" && phase.busy === true;

  if (phase.kind === "sign_in_again") return <SignInAgainView onContinue={onContinue} />;

  if (phase.kind === "checking" || phase.kind === "leaving") {
    return (
      <AuthCard title={AUTH_LABELS.confirmTitle}>
        <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
          {phase.kind === "checking" ? AUTH_LABELS.confirming : AUTH_LABELS.signingIn}
        </p>
      </AuthCard>
    );
  }

  if (phase.kind === "stopped") {
    return (
      <AuthCard title={AUTH_LABELS.confirmTitle}>
        <p className="text-center text-sm text-neutral-600 dark:text-neutral-300">{phase.message}</p>
        <BackToSignIn />
      </AuthCard>
    );
  }

  if (phase.kind === "retry") {
    return (
      <AuthCard title={AUTH_LABELS.confirmTitle}>
        <p className="text-center text-sm text-neutral-600 dark:text-neutral-300">{phase.message}</p>
        <button type="button" onClick={onRetry} disabled={!hydrated} className={PRIMARY_BUTTON_CLASS}>
          {AUTH_LABELS.tryAgain}
        </button>
        <BackToSignIn />
      </AuthCard>
    );
  }

  async function submit() {
    setError(null);
    const message = await onSignIn(email, password);
    setPassword("");
    if (message) setError(message);
  }

  return (
    <AuthCard title={AUTH_LABELS.confirmTitle} lead={AUTH_MESSAGES.confirmSignIn}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <EmailField value={email} onChange={setEmail} disabled={busy} autoFocus />
        <PasswordField isNew={false} value={password} onChange={setPassword} disabled={busy} />
        <PrimaryButton busy={busy} busyLabel={AUTH_LABELS.signingIn} label={AUTH_LABELS.signIn} />
      </form>
      <Messages error={error} />
      <BackToSignIn />
    </AuthCard>
  );
}
