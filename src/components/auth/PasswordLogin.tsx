"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { accessDeniedMessage, WORKSPACE_NOT_SET_UP_MESSAGE } from "@/lib/auth/accessDenied";
import { mintSession } from "@/lib/auth/clientSession";
import { getClientAuth, googleProvider } from "@/lib/auth/firebaseClient";
import { AUTH_MESSAGES, linkSentMessage, resetSentMessage } from "@/lib/auth/messages";
import {
  afterSignInPath,
  authErrorCode,
  authErrorEmail,
  authErrorMessage,
  checkCodeMessage,
  cleanCode,
  DEFAULT_RESEND_AFTER,
  emailCodeChecker,
  forgotOutcome,
  isContinueUrlRefused,
  looksLikeEmail,
  newPasswordProblem,
  requestEmailCode,
  requestEmailLink,
  resetContinueUrl,
  sendCodeMessage,
  sendLinkMessage,
  startPasswordBotChecks,
  type SendCodeResult,
} from "@/lib/auth/passwordClient";
import { liveMessage, LiveRegion } from "./parts";
import { CodeView, CreateView, ForgotView, SignInAgainView, SignInView, type Busy, type LegalHrefs } from "./views";

export type PasswordLoginView = "sign_in" | "create" | "code" | "forgot" | "sign_in_again";

const hasPassword = (user: User) => user.providerData.some((p) => p.providerId === "password");

/**
 * Sign in with Google or an email and password, create an account, confirm it with the emailed
 * code, and ask for a password reset. The password goes from this page to Identity Platform only;
 * our server sees Google's ID token. Every way in ends at mintSession (the door), and each of its
 * answers has its own screen or message.
 */
export function PasswordLogin({ selfServeSignup, legal }: { selfServeSignup: boolean; legal: LegalHrefs }) {
  const router = useRouter();
  const [view, setView] = useState<PasswordLoginView>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The code screen: the address the code went to, where "Start again" goes, when to offer another.
  const [codeEmail, setCodeEmail] = useState("");
  const [codeFrom, setCodeFrom] = useState<"create" | "sign_in">("create");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  // The address had too many wrong codes today: the code screen offers a link instead.
  const [codesLocked, setCodesLocked] = useState(false);
  // A link is on its way: another waits as long as another code would, since a new link replaces it.
  const [linkSent, setLinkSent] = useState(false);
  // Remembers an accepted code, so a retry after the door failed doesn't hear "expired".
  const [codeCheck] = useState(() => emailCodeChecker());

  // reCAPTCHA (addon:password turns it on) scores a password call only once its config is loaded.
  useEffect(() => {
    try {
      startPasswordBotChecks(getClientAuth());
    } catch {
      // No client sign-in config in this browser: the password calls will say so.
    }
  }, []);

  useEffect(() => {
    if (view !== "code" || resendAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= resendAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [view, resendAt]);

  const resendIn = Math.max(0, Math.ceil((resendAt - now) / 1000));

  function show(next: PasswordLoginView) {
    setView(next);
    setError(null);
    setNotice(null);
  }

  function fail(message: string | null) {
    setError(message);
    setBusy(null);
  }

  function waitBeforeResend(seconds: number) {
    const t = Date.now();
    setNow(t);
    setResendAt(t + seconds * 1000);
  }

  /** Hands the signed-in account to the door and acts on its answer. */
  async function finish(user: User, confirmed: boolean): Promise<void> {
    const result = await mintSession(user);
    switch (result) {
      case "ok":
        // Stay busy: the page is leaving.
        router.push(afterSignInPath(window.location.search));
        router.refresh();
        return;
      case "forbidden":
        return fail(accessDeniedMessage());
      case "not_set_up":
        return fail(WORKSPACE_NOT_SET_UP_MESSAGE);
      case "google_only":
        return fail(AUTH_MESSAGES.googleOnly);
      case "email_not_verified":
        // Just confirmed, yet still unconfirmed at the door, or not a password account (only those
        // get a code): don't go round again.
        if (confirmed || !hasPassword(user)) return fail(AUTH_MESSAGES.somethingWentWrong);
        return startCode(user, "sign_in");
      case "sign_in_again":
        await signOut(getClientAuth()).catch(() => undefined);
        setPassword("");
        setCode("");
        show("sign_in_again");
        setBusy(null);
        return;
      case "address_updated":
        // A renamed Google address: the move revoked this sign-in, so the next Google sign-in gets in.
        await signOut(getClientAuth()).catch(() => undefined);
        setPassword("");
        show("sign_in");
        return fail(AUTH_MESSAGES.googleAddressChanged);
      default:
        return fail(AUTH_MESSAGES.somethingWentWrong);
    }
  }

  /** Emails a code to a signed-in password account and shows the code screen. */
  async function startCode(user: User, from: "create" | "sign_in"): Promise<void> {
    const result = await requestEmailCode(await user.getIdToken());
    if (result.kind === "already_verified") {
      await user.getIdToken(true);
      return finish(user, true);
    }
    setCodeEmail(user.email ?? email.trim());
    setCodeFrom(from);
    setCode("");
    setCodesLocked(result.kind === "locked");
    setLinkSent(false);
    waitBeforeResend(result.kind === "sent" ? result.resendAfter : DEFAULT_RESEND_AFTER);
    setView("code");
    setError(sendCodeMessage(result));
    setNotice(result.kind === "sent" && from === "sign_in" ? AUTH_MESSAGES.emailNotConfirmed : null);
    setBusy(null);
  }

  async function signInWithGoogle() {
    setBusy("google");
    setError(null);
    setNotice(null);
    try {
      const cred = await signInWithPopup(getClientAuth(), googleProvider());
      await finish(cred.user, false);
    } catch (err) {
      const named = authErrorEmail(err);
      if (named && authErrorCode(err) === "auth/account-exists-with-different-credential") setEmail(named);
      fail(authErrorMessage(err, "google"));
    }
  }

  async function signInWithPassword() {
    if (!looksLikeEmail(email)) return fail(AUTH_MESSAGES.emailLooksWrong);
    if (!password) return fail(AUTH_MESSAGES.passwordMissing);
    setBusy("form");
    setError(null);
    setNotice(null);
    try {
      const cred = await signInWithEmailAndPassword(getClientAuth(), email.trim(), password);
      setPassword("");
      if (!cred.user.emailVerified) return await startCode(cred.user, "sign_in");
      await finish(cred.user, false);
    } catch (err) {
      fail(authErrorMessage(err, "sign_in"));
    }
  }

  async function createAccount() {
    if (!name.trim()) return fail(AUTH_MESSAGES.nameMissing);
    if (!looksLikeEmail(email)) return fail(AUTH_MESSAGES.emailLooksWrong);
    setBusy("form");
    setError(null);
    setNotice(null);
    const problem = await newPasswordProblem(password);
    if (problem) return fail(problem);
    try {
      const cred = await createUserWithEmailAndPassword(getClientAuth(), email.trim(), password);
      setPassword("");
      // The name is a nicety: an account without one still confirms and signs in.
      await updateProfile(cred.user, { displayName: name.trim() }).catch(() => undefined);
      await startCode(cred.user, "create");
    } catch (err) {
      fail(authErrorMessage(err, "create"));
    }
  }

  /** The browser's signed-in account, or back to sign in when it has gone (another tab signed out). */
  function codeUser(): User | null {
    const user = getClientAuth().currentUser;
    if (!user) {
      show("sign_in");
      setError(AUTH_MESSAGES.somethingWentWrong);
    }
    return user;
  }

  async function confirmCode() {
    const digits = cleanCode(code);
    if (digits.length !== 6) return fail(AUTH_MESSAGES.codeIncomplete);
    const user = codeUser();
    if (!user) return;
    setBusy("form");
    setError(null);
    setNotice(null);
    try {
      const result = await codeCheck.check(user.uid, () => user.getIdToken(), digits);
      if (result.kind !== "ok") {
        // A code that is used up can't be retried: clear it and offer a new one at once.
        if (result.kind === "expired" || result.kind === "too_many" || result.kind === "locked") {
          setCode("");
          setResendAt(0);
        }
        // No more codes today: offer the link in their place.
        if (result.kind === "locked") setCodesLocked(true);
        return fail(checkCodeMessage(result));
      }
      // The check marked the account confirmed; a fresh token carries that to the door.
      await user.getIdToken(true);
      await finish(user, true);
    } catch {
      fail(AUTH_MESSAGES.somethingWentWrong);
    }
  }

  async function resendCode() {
    const user = codeUser();
    if (!user) return;
    setBusy("form");
    setError(null);
    setNotice(null);
    try {
      const result: SendCodeResult = await requestEmailCode(await user.getIdToken());
      if (result.kind === "already_verified") {
        await user.getIdToken(true);
        return await finish(user, true);
      }
      waitBeforeResend(result.kind === "sent" ? result.resendAfter : DEFAULT_RESEND_AFTER);
      if (result.kind === "locked") setCodesLocked(true);
      setNotice(result.kind === "sent" ? AUTH_MESSAGES.codeResent : null);
      fail(sendCodeMessage(result));
    } catch {
      fail(AUTH_MESSAGES.somethingWentWrong);
    }
  }

  /** Emails a link that confirms the address, once codes are locked for it. */
  async function emailLink() {
    const user = codeUser();
    if (!user) return;
    setBusy("form");
    setError(null);
    setNotice(null);
    try {
      const result = await requestEmailLink(await user.getIdToken());
      if (result.kind === "already_verified") {
        await user.getIdToken(true);
        return await finish(user, true);
      }
      if (result.kind === "sent") {
        setLinkSent(true);
        waitBeforeResend(DEFAULT_RESEND_AFTER);
      }
      setNotice(result.kind === "sent" ? linkSentMessage(codeEmail) : null);
      fail(sendLinkMessage(result));
    } catch {
      fail(AUTH_MESSAGES.somethingWentWrong);
    }
  }

  async function startAgain() {
    setBusy("form");
    codeCheck.forget();
    await signOut(getClientAuth()).catch(() => undefined);
    setCode("");
    setPassword("");
    setResendAt(0);
    setCodesLocked(false);
    setLinkSent(false);
    show(codeFrom);
    setBusy(null);
  }

  async function sendResetLink() {
    if (!looksLikeEmail(email)) return fail(AUTH_MESSAGES.emailLooksWrong);
    const address = email.trim();
    setBusy("form");
    setError(null);
    setNotice(null);
    const auth = getClientAuth();
    let err: unknown = null;
    try {
      await sendPasswordResetEmail(auth, address, { url: resetContinueUrl(window.location.origin) });
    } catch (first) {
      err = first;
      // This copy's address isn't on Firebase's list for continue links: send the plain email instead.
      if (isContinueUrlRefused(first)) {
        try {
          await sendPasswordResetEmail(auth, address);
          err = null;
        } catch (second) {
          err = second;
        }
      }
    }
    const outcome = forgotOutcome(err);
    if (outcome === "sent") setNotice(resetSentMessage(address));
    fail(outcome === "sent" ? null : outcome);
  }

  // One live region for every screen, so a message set with a change of screen is read out too.
  return (
    <>
      {screen()}
      <LiveRegion message={view === "sign_in_again" ? AUTH_MESSAGES.signInAgainBody : liveMessage(error, notice)} />
    </>
  );

  function screen() {
    switch (view) {
      case "create":
        return (
          <CreateView
            name={name}
            onName={setName}
            email={email}
            onEmail={setEmail}
            password={password}
            onPassword={setPassword}
            busy={busy}
            error={error}
            selfServeSignup={selfServeSignup}
            legal={legal}
            onSubmit={createAccount}
            onSignIn={() => show("sign_in")}
          />
        );
      case "code":
        return (
          <CodeView
            email={codeEmail}
            code={code}
            onCode={(v) => setCode(cleanCode(v))}
            busy={busy}
            error={error}
            notice={notice}
            resendIn={resendIn}
            selfServeSignup={selfServeSignup}
            codesLocked={codesLocked}
            linkSent={linkSent}
            onSubmit={confirmCode}
            onResend={resendCode}
            onEmailLink={emailLink}
            onStartAgain={startAgain}
          />
        );
      case "forgot":
        return (
          <ForgotView
            email={email}
            onEmail={setEmail}
            busy={busy}
            error={error}
            notice={notice}
            onSubmit={sendResetLink}
            onBack={() => show("sign_in")}
          />
        );
      case "sign_in_again":
        return <SignInAgainView onContinue={() => show("sign_in")} />;
      default:
        return (
          <SignInView
            email={email}
            onEmail={setEmail}
            password={password}
            onPassword={setPassword}
            busy={busy}
            error={error}
            notice={notice}
            onGoogle={signInWithGoogle}
            onSubmit={signInWithPassword}
            onForgot={() => show("forgot")}
            onCreate={() => show("create")}
          />
        );
    }
  }
}
