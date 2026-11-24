"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  signOut,
  updatePassword,
  type User,
} from "firebase/auth";
import { LiveRegion, PasswordField } from "@/components/auth/parts";
import { getClientAuth } from "@/lib/auth/firebaseClient";
import { mintSession, refreshSession } from "@/lib/auth/clientSession";
import { AUTH_LABELS, AUTH_MESSAGES, SIGN_IN_SECURITY_COPY } from "@/lib/auth/messages";
import { authErrorCode, newPasswordProblem, startPasswordBotChecks } from "@/lib/auth/passwordClient";

/**
 * Settings › General, "Sign-in and security" (PASSWORD_SIGNIN_ENABLED; the page decides whether it
 * shows). How this account signs in, read from the browser's own Firebase user; Change password for
 * accounts that have a password; and Sign out everywhere.
 *
 * The password goes from this browser to Identity Platform only, never to our server: check the
 * current one (reauthenticateWithCredential), save the new one (updatePassword), sign in again
 * with it, then mint a fresh session cookie. A password change revokes every session cookie, this
 * tab's too, so without the mint this tab would be signed out with the others; when the mint
 * fails, the message says to sign in again.
 *
 * Sign out everywhere asks the server to revoke every sign-in (DELETE /api/auth/session
 * ?scope=everywhere), then signs this browser out and goes to /login.
 */

/** The card's own fixed lines (src/lib/auth/messages.ts), re-exported for its tests and the help page. */
export { SIGN_IN_SECURITY_COPY };

/** The DELETE that revokes every sign-in for this account. */
export const SIGN_OUT_EVERYWHERE_URL = "/api/auth/session?scope=everywhere";

const PROVIDER_LABELS: Record<string, string> = { password: "Password", "google.com": "Google" };
const PROVIDER_ORDER = ["password", "google.com"];

/** The chips under "How you sign in": Password first, then Google, then anything else by its id. */
export function signInMethods(providerData: ReadonlyArray<{ providerId: string }>): string[] {
  const rank = (id: string) => {
    const at = PROVIDER_ORDER.indexOf(id);
    return at === -1 ? PROVIDER_ORDER.length : at;
  };
  return [...new Set(providerData.map((p) => p.providerId))]
    .sort((a, b) => rank(a) - rank(b))
    .map((id) => PROVIDER_LABELS[id] ?? id);
}

/** Change password is offered only to accounts that sign in with a password. */
export function hasPasswordSignIn(user: Pick<User, "providerData">): boolean {
  return user.providerData.some((p) => p.providerId === "password");
}

const WRONG_CURRENT = new Set([
  "auth/wrong-password",
  "auth/invalid-credential",
  "auth/invalid-login-credentials",
  "auth/missing-password",
]);

/** What to say when Identity Platform turns down the check or the change, by its error code. */
export function changePasswordMessage(code: string | null): string {
  if (code && WRONG_CURRENT.has(code)) return AUTH_MESSAGES.currentPasswordWrong;
  switch (code) {
    case "auth/too-many-requests":
      return AUTH_MESSAGES.tooManyTries;
    case "auth/user-disabled":
      return AUTH_MESSAGES.accountDisabled;
    case "auth/weak-password":
      return AUTH_MESSAGES.passwordTooShort;
    case "auth/password-does-not-meet-requirements":
      return AUTH_MESSAGES.passwordRulesNotMet;
    default:
      return AUTH_MESSAGES.somethingWentWrong;
  }
}

/**
 * Check the new password against the rules, check the current one, save the new one, then mint
 * this tab a fresh session cookie. Never throws; the message is the one to show.
 */
export async function changePassword(
  user: User,
  current: string,
  next: string,
): Promise<{ ok: boolean; message: string }> {
  const problem = await newPasswordProblem(next);
  if (problem) return { ok: false, message: problem };
  if (!current) return { ok: false, message: AUTH_MESSAGES.currentPasswordWrong };
  const email = user.email ?? user.providerData.find((p) => p.providerId === "password")?.email ?? null;
  if (!email) return { ok: false, message: AUTH_MESSAGES.somethingWentWrong };
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, current));
    await updatePassword(user, next);
  } catch (err) {
    return { ok: false, message: changePasswordMessage(authErrorCode(err)) };
  }
  // The password is saved, and the change revoked every sign-in from before it, this tab's too.
  // The token updatePassword left behind keeps the earlier sign-in time, so the door would treat
  // it as revoked: sign in again with the new password for a token from after the change, then
  // mint this tab a fresh session cookie.
  let minted: string;
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, next));
    minted = await mintSession(user);
  } catch {
    minted = "error";
  }
  // An address that gets in only through the team's domain may not use a password at the door
  // (google_only), so this tab has to sign in again with Google, not the new password.
  const message =
    minted === "ok"
      ? AUTH_MESSAGES.passwordChanged
      : minted === "google_only"
        ? AUTH_MESSAGES.passwordChangedUseGoogle
        : AUTH_MESSAGES.passwordChangedSignInAgain;
  return { ok: true, message };
}

/**
 * Revoke every sign-in on the server, then sign this browser out. True when the server did it; the
 * caller then goes to /login. A session that lapsed while the page was open is minted again from
 * this browser's sign-in and tried once more (the fetch interceptor leaves /api/auth/session alone).
 */
export async function signOutEverywhere(): Promise<boolean> {
  const revoke = () => fetch(SIGN_OUT_EVERYWHERE_URL, { method: "DELETE" }).catch(() => null);
  let res = await revoke();
  if (res?.status === 401 && (await refreshSession())) res = await revoke();
  if (!res?.ok) return false;
  try {
    await signOut(getClientAuth());
  } catch {
    // The server has already revoked every sign-in, this browser's included.
  }
  return true;
}

const ROW = "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3";
const NOTE = "text-xs text-neutral-500 dark:text-neutral-400";
const BUTTON =
  "shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900";
const PRIMARY = "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900";
const CHIP = "inline-flex items-center rounded-full border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700";
const ERROR = "text-xs text-red-600 dark:text-red-400";

/** The card, following the browser's Firebase user as it loads. */
export function SignInSecurityCard() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    try {
      const auth = getClientAuth();
      // Change password signs in with the password, which reCAPTCHA scores once its config is loaded.
      startPasswordBotChecks(auth);
      return onAuthStateChanged(auth, (u) => setUser(u));
    } catch {
      // No client sign-in config in this browser: show what works without it.
      setUser(null);
      return undefined;
    }
  }, []);
  return <SignInSecurity user={user} />;
}

/** The card for a known state: undefined while loading, null with no sign-in in this browser. */
export function SignInSecurity({ user }: { user: User | null | undefined }) {
  const c = SIGN_IN_SECURITY_COPY;
  const headingId = useId();
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState<string | null>(null);
  // After the form closes, focus goes back to Change password rather than dropping to the page.
  const changeButton = useRef<HTMLButtonElement>(null);
  const focusChangeButton = useRef(false);
  useEffect(() => {
    if (!changing && focusChangeButton.current) {
      focusChangeButton.current = false;
      changeButton.current?.focus();
    }
  }, [changing]);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  // Sign out everywhere asks first, in the card (no browser dialog); Cancel puts focus back.
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const leaveButton = useRef<HTMLButtonElement>(null);
  const focusLeaveButton = useRef(false);
  useEffect(() => {
    if (!confirmingLeave && focusLeaveButton.current) {
      focusLeaveButton.current = false;
      leaveButton.current?.focus();
    }
  }, [confirmingLeave]);

  const everywhere = async () => {
    setLeaving(true);
    setLeaveError(null);
    if (await signOutEverywhere()) {
      window.location.assign("/login");
      return;
    }
    setLeaving(false);
    setLeaveError(AUTH_MESSAGES.somethingWentWrong);
  };

  return (
    <section className="max-w-2xl space-y-2" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-sm font-semibold">
        {c.title}
      </h2>
      <div className="divide-y divide-neutral-100 rounded-md border border-neutral-200 text-sm dark:divide-neutral-900 dark:border-neutral-800">
        <div className={ROW}>
          <div className="min-w-0 space-y-1.5">
            <p>{c.howYouSignIn}</p>
            {user === undefined ? (
              <p className={NOTE}>{c.loading}</p>
            ) : user === null ? (
              <p className={NOTE}>{c.signInAgainToSee}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5" aria-label={c.howYouSignIn}>
                {signInMethods(user.providerData).map((m) => (
                  <li key={m} className={CHIP}>
                    {m}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {user && hasPasswordSignIn(user) ? (
          <div className="space-y-3 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 space-y-0.5">
                <p>{c.password}</p>
                <p className={NOTE}>{c.passwordNote}</p>
              </div>
              {changing ? null : (
                <button
                  ref={changeButton}
                  type="button"
                  className={BUTTON}
                  onClick={() => {
                    setChanging(true);
                    setChanged(null);
                  }}
                >
                  {c.changePassword}
                </button>
              )}
            </div>
            {changing ? (
              <ChangePasswordForm
                user={user}
                onDone={(message) => {
                  focusChangeButton.current = true;
                  setChanging(false);
                  setChanged(message);
                }}
                onCancel={() => {
                  focusChangeButton.current = true;
                  setChanging(false);
                }}
              />
            ) : null}
            {changed ? <p className="text-xs text-green-700 dark:text-green-400">{changed}</p> : null}
            {/* Mounted from the start, so screen readers announce the result when it arrives. */}
            <LiveRegion message={changed ?? ""} />
          </div>
        ) : null}

        <div className={ROW}>
          <div className="min-w-0 space-y-0.5">
            <p>{c.devices}</p>
            <p className={NOTE}>{c.devicesNote}</p>
          </div>
          {confirmingLeave ? null : (
            <button ref={leaveButton} type="button" className={BUTTON} onClick={() => setConfirmingLeave(true)}>
              {c.signOutEverywhere}
            </button>
          )}
          {confirmingLeave ? (
            <SignOutEverywhereConfirm
              leaving={leaving}
              onYes={() => void everywhere()}
              onCancel={() => {
                focusLeaveButton.current = true;
                setConfirmingLeave(false);
              }}
            />
          ) : null}
          {leaveError ? (
            <p role="alert" className={`w-full ${ERROR}`}>
              {leaveError}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** "Sign out on every device, this one included?" with Yes and Cancel, before anything is revoked. */
export function SignOutEverywhereConfirm({ leaving, onYes, onCancel }: { leaving: boolean; onYes: () => void; onCancel: () => void }) {
  const c = SIGN_IN_SECURITY_COPY;
  return (
    <div role="group" aria-label={c.signOutEverywhere} className="w-full space-y-2">
      <p>{c.signOutEverywhereConfirm}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={PRIMARY} disabled={leaving} onClick={onYes} autoFocus>
          {leaving ? c.signingOut : c.signOutEverywhereYes}
        </button>
        <button type="button" className={BUTTON} disabled={leaving} onClick={onCancel}>
          {c.cancel}
        </button>
      </div>
    </div>
  );
}

/** Current and new password, each with Show, under the Password row. */
export function ChangePasswordForm({
  user,
  onDone,
  onCancel,
}: {
  user: User;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const c = SIGN_IN_SECURITY_COPY;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await changePassword(user, current, next);
    setBusy(false);
    if (out.ok) onDone(out.message);
    else setError(out.message);
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      noValidate
      className="max-w-sm space-y-3 border-t border-neutral-100 pt-3 dark:border-neutral-900"
    >
      {/* Lets a password manager file the new password under the right account. */}
      <input type="email" name="username" autoComplete="username" value={user.email ?? ""} readOnly hidden />
      <PasswordField
        label={c.currentPassword}
        value={current}
        onChange={setCurrent}
        isNew={false}
        disabled={busy}
        autoFocus
      />
      <PasswordField
        value={next}
        onChange={setNext}
        isNew
        hint={AUTH_MESSAGES.passwordRule}
        disabled={busy}
      />
      {error ? (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={PRIMARY} disabled={busy || !current || !next}>
          {busy ? AUTH_LABELS.saving : AUTH_LABELS.savePassword}
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onCancel}>
          {c.cancel}
        </button>
      </div>
    </form>
  );
}
