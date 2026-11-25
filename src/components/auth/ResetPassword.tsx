"use client";

import { useEffect, useRef, useState } from "react";
import { applyActionCode, checkActionCode, confirmPasswordReset, sendPasswordResetEmail, verifyPasswordResetCode } from "firebase/auth";
import { getClientAuth } from "@/lib/auth/firebaseClient";
import { AUTH_LABELS, AUTH_MESSAGES, recoverDoneMessage, resetForMessage, resetSentMessage } from "@/lib/auth/messages";
import { authErrorCode, authErrorMessage, newPasswordProblem, readResetLink, type ResetLink } from "@/lib/auth/passwordClient";
import { AuthCard, LINK_CLASS, LiveRegion, Messages, PasswordField, PrimaryButton, PRIMARY_BUTTON_CLASS } from "./parts";

/**
 * Where the page is: reading the link, the form, saved, a link it can't use, or a check that
 * failed for a reason other than the link (offline), which can be tried again.
 */
export type ResetPhase =
  | { kind: "checking" }
  | { kind: "form"; email: string }
  | { kind: "done" }
  | { kind: "stopped"; message: string }
  | { kind: "retry"; message: string }
  /** An "undo the email change" link was used: the account signs in with `email` again. */
  | { kind: "recovered"; email: string; sent: boolean };

/** What the page says once checking the link failed: a network failure can be tried again. */
export function resetCheckFailed(err: unknown): ResetPhase {
  return authErrorCode(err) === "auth/network-request-failed"
    ? { kind: "retry", message: AUTH_MESSAGES.somethingWentWrong }
    : { kind: "stopped", message: AUTH_MESSAGES.resetLinkBad };
}

/** What the page says once an "undo the email change" link failed: a network failure can be tried again. */
export function recoverCheckFailed(err: unknown): ResetPhase {
  return authErrorCode(err) === "auth/network-request-failed"
    ? { kind: "retry", message: AUTH_MESSAGES.somethingWentWrong }
    : { kind: "stopped", message: AUTH_MESSAGES.recoverLinkBad };
}

/** Reads which address the link restores, restores it, then says so. */
function recoverEmail(code: string, setPhase: (phase: ResetPhase) => void): void {
  const auth = getClientAuth();
  checkActionCode(auth, code)
    .then(async (info) => {
      await applyActionCode(auth, code);
      setPhase({ kind: "recovered", email: info.data.email ?? "", sent: false });
    })
    .catch((err: unknown) => setPhase(recoverCheckFailed(err)));
}

/** Asks Firebase whose link the code is for, then shows the form, or why it can't. */
function checkResetCode(code: string, setPhase: (phase: ResetPhase) => void): void {
  verifyPasswordResetCode(getClientAuth(), code).then(
    (email) => setPhase({ kind: "form", email }),
    (err: unknown) => setPhase(resetCheckFailed(err)),
  );
}

/** Why the page can't use the link it took from the address bar. */
export function resetLinkStop(link: Exclude<ResetLink, { kind: "reset" | "recover" }>): ResetPhase {
  switch (link.kind) {
    case "wrong_mode":
      return { kind: "stopped", message: AUTH_MESSAGES.resetLinkWrongMode };
    case "empty":
      return { kind: "stopped", message: AUTH_MESSAGES.resetLinkReopen };
    case "bad":
      return { kind: "stopped", message: AUTH_MESSAGES.resetLinkBad };
  }
}

/**
 * Reads the reset link from the address bar, then takes it out of the address bar and history at
 * once, whatever the link holds and whether or not the switch is on.
 */
export function takeResetLink(win: { location: Pick<Location, "search" | "pathname">; history: Pick<History, "replaceState"> }): ResetLink {
  const link = readResetLink(win.location.search);
  win.history.replaceState(null, "", win.location.pathname);
  return link;
}

/**
 * Where the reset email's link lands (/auth/reset?mode=resetPassword&oobCode=...). The one-time
 * code leaves the address bar before anything else happens, so it isn't kept in history, shared
 * or sent on as a referrer. Firebase checks the code and saves the new password from the browser.
 */
export function ResetPassword({ enabled }: { enabled: boolean }) {
  const [phase, setPhase] = useState<ResetPhase>(enabled ? { kind: "checking" } : { kind: "stopped", message: AUTH_MESSAGES.passwordSigninOff });
  const oobCode = useRef<string | null>(null);
  const recovering = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const link = takeResetLink(window);
    // Undoing an email change doesn't depend on password sign-in: whoever lost their address
    // must be able to get it back.
    if (link.kind === "recover") {
      oobCode.current = link.oobCode;
      recovering.current = true;
      setPhase({ kind: "checking" });
      return recoverEmail(link.oobCode, setPhase);
    }
    if (!enabled) return;
    if (link.kind !== "reset") return setPhase(resetLinkStop(link));
    // The code now lives only here, so a failed check can be tried again without the link.
    oobCode.current = link.oobCode;
    checkResetCode(link.oobCode, setPhase);
  }, [enabled]);

  return (
    <ResetPasswordView
      phase={phase}
      onSave={(password) => save(password)}
      onRetry={retry}
      onSendReset={enabled ? sendReset : undefined}
    />
  );

  function retry() {
    const code = oobCode.current;
    if (!code) return setPhase({ kind: "stopped", message: AUTH_MESSAGES.resetLinkReopen });
    setPhase({ kind: "checking" });
    if (recovering.current) recoverEmail(code, setPhase);
    else checkResetCode(code, setPhase);
  }

  /** After an email change was undone: a reset link to the restored address, in case the password is known. */
  async function sendReset(email: string): Promise<string | null> {
    try {
      await sendPasswordResetEmail(getClientAuth(), email, { url: `${window.location.origin}/login` });
      setPhase({ kind: "recovered", email, sent: true });
      return null;
    } catch {
      return AUTH_MESSAGES.somethingWentWrong;
    }
  }

  async function save(password: string): Promise<string | null> {
    const problem = await newPasswordProblem(password);
    if (problem) return problem;
    const code = oobCode.current;
    if (!code) return AUTH_MESSAGES.resetLinkBad;
    try {
      await confirmPasswordReset(getClientAuth(), code, password);
      oobCode.current = null;
      setPhase({ kind: "done" });
      return null;
    } catch (err) {
      return authErrorMessage(err, "reset");
    }
  }
}

/** What the reset page's live region says in each phase. */
function resetLiveMessage(phase: ResetPhase, error: string | null): string {
  switch (phase.kind) {
    case "checking":
      return AUTH_LABELS.checkingLink;
    case "done":
      return AUTH_MESSAGES.resetDone;
    case "stopped":
    case "retry":
      return phase.message;
    case "recovered":
      return phase.sent ? resetSentMessage(phase.email) : recoverDoneMessage(phase.email);
    default:
      return error ?? "";
  }
}

/**
 * The screens, from the phase only. onSave answers with an error message, or null once saved. One
 * live region outside the screens reads out each phase's message as it arrives.
 */
export function ResetPasswordView({
  phase,
  onSave,
  onRetry = () => {},
  onSendReset,
}: {
  phase: ResetPhase;
  onSave: (password: string) => Promise<string | null>;
  onRetry?: () => void;
  /** Sends a reset link after an email change was undone; absent while password sign-in is off. */
  onSendReset?: (email: string) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ResetScreen phase={phase} onSave={onSave} onRetry={onRetry} onSendReset={onSendReset} error={error} setError={setError} />
      <LiveRegion message={resetLiveMessage(phase, error)} />
    </>
  );
}

/** The way back to the sign-in page, on every screen but the first check. */
function BackToSignIn({ label = AUTH_LABELS.backToSignIn }: { label?: string }) {
  return (
    <p className="text-center text-sm">
      <a href="/login" className={LINK_CLASS}>
        {label}
      </a>
    </p>
  );
}

function ResetScreen({
  phase,
  onSave,
  onRetry,
  onSendReset,
  error,
  setError,
}: {
  phase: ResetPhase;
  onSave: (password: string) => Promise<string | null>;
  onRetry: () => void;
  onSendReset?: (email: string) => Promise<string | null>;
  error: string | null;
  setError: (message: string | null) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (phase.kind === "recovered") {
    const send = onSendReset;
    return (
      <AuthCard title={AUTH_LABELS.recoverTitle}>
        <p className="text-center text-sm text-neutral-600 dark:text-neutral-300">{recoverDoneMessage(phase.email)}</p>
        {phase.sent ? (
          <p className="text-center text-sm text-neutral-600 dark:text-neutral-300">{resetSentMessage(phase.email)}</p>
        ) : (
          <>
            <p className="text-center text-sm text-neutral-600 dark:text-neutral-300">{AUTH_MESSAGES.recoverAdvice}</p>
            {send && phase.email ? (
              <button
                type="button"
                disabled={busy}
                className={PRIMARY_BUTTON_CLASS}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  const message = await send(phase.email);
                  if (message) setError(message);
                  setBusy(false);
                }}
              >
                {busy ? AUTH_LABELS.sending : AUTH_LABELS.sendResetLink}
              </button>
            ) : null}
          </>
        )}
        <Messages error={error} />
        <BackToSignIn />
      </AuthCard>
    );
  }

  if (phase.kind === "checking") {
    return (
      <AuthCard title={AUTH_LABELS.resetTitle}>
        <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
          {AUTH_LABELS.checkingLink}
        </p>
      </AuthCard>
    );
  }

  if (phase.kind === "done" || phase.kind === "stopped") {
    return (
      <AuthCard title={phase.kind === "done" ? AUTH_LABELS.resetTitle : AUTH_LABELS.forgotTitle}>
        <p className="text-center text-sm text-neutral-600 dark:text-neutral-300">
          {phase.kind === "done" ? AUTH_MESSAGES.resetDone : phase.message}
        </p>
        <BackToSignIn label={phase.kind === "done" ? AUTH_LABELS.signIn : AUTH_LABELS.backToSignIn} />
      </AuthCard>
    );
  }

  if (phase.kind === "retry") {
    return (
      <AuthCard title={AUTH_LABELS.resetTitle}>
        <p className="text-center text-sm text-neutral-600 dark:text-neutral-300">{phase.message}</p>
        <button type="button" onClick={onRetry} className={PRIMARY_BUTTON_CLASS}>
          {AUTH_LABELS.tryAgain}
        </button>
        <BackToSignIn />
      </AuthCard>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const message = await onSave(password);
    if (message) {
      setError(message);
      setBusy(false);
    }
  }

  return (
    <AuthCard title={AUTH_LABELS.resetTitle} lead={resetForMessage(phase.email)}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* Lets the browser's password manager save the new password against the right account. */}
        <input type="email" name="email" autoComplete="username" value={phase.email} readOnly hidden />
        <PasswordField isNew value={password} onChange={setPassword} hint={AUTH_MESSAGES.passwordRule} disabled={busy} autoFocus />
        <PrimaryButton busy={busy} busyLabel={AUTH_LABELS.saving} label={AUTH_LABELS.savePassword} />
      </form>
      <Messages error={error} />
      <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">{AUTH_MESSAGES.resetLinkOnce}</p>
      <BackToSignIn />
    </AuthCard>
  );
}
