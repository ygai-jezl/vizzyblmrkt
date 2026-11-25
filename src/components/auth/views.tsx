"use client";

import { Fragment, type ReactNode } from "react";
import { AUTH_LABELS, AUTH_MESSAGES, codeSentMessage, resendInMessage, sendLinkInMessage } from "@/lib/auth/messages";
import {
  AuthCard,
  CodeField,
  EmailField,
  GoogleButton,
  LinkButton,
  Messages,
  OrRule,
  PasswordField,
  PRIMARY_BUTTON_CLASS,
  PrimaryButton,
  TextField,
} from "./parts";

/**
 * The password sign-in screens, drawn from props only: PasswordLogin holds the state and does the
 * work. Each form validates itself (noValidate) so people read our messages, not the browser's.
 */

/** The deployment's legal pages, when it publishes them (src/lib/legal/pages.ts). */
export interface LegalHrefs {
  terms: string | null;
  privacy: string | null;
}

/** Which action is running: the Google button, the screen's form, or none. Every button waits while one runs. */
export type Busy = null | "google" | "form";

function Form({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

function Foot({ children }: { children: ReactNode }) {
  return <div className="space-y-2 text-center text-sm text-neutral-500 dark:text-neutral-400">{children}</div>;
}

export function SignInView(props: {
  email: string;
  onEmail: (v: string) => void;
  password: string;
  onPassword: (v: string) => void;
  busy: Busy;
  error: string | null;
  notice?: string | null;
  onGoogle: () => void;
  onSubmit: () => void;
  onForgot: () => void;
  onCreate: () => void;
}) {
  const locked = props.busy !== null;
  return (
    <AuthCard title={AUTH_LABELS.signInTitle}>
      <GoogleButton onClick={props.onGoogle} busy={props.busy === "google"} disabled={locked} />
      <OrRule />
      <Form onSubmit={props.onSubmit}>
        <EmailField value={props.email} onChange={props.onEmail} disabled={locked} />
        <PasswordField
          isNew={false}
          value={props.password}
          onChange={props.onPassword}
          disabled={locked}
          labelAside={
            <span className="text-xs">
              <LinkButton onClick={props.onForgot} disabled={locked}>
                {AUTH_LABELS.forgotPassword}
              </LinkButton>
            </span>
          }
        />
        <PrimaryButton busy={props.busy === "form"} busyLabel={AUTH_LABELS.signingIn} label={AUTH_LABELS.signIn} disabled={locked} />
      </Form>
      <Messages error={props.error} notice={props.notice} />
      <Foot>
        <p>
          {AUTH_LABELS.firstTime}{" "}
          <LinkButton onClick={props.onCreate} disabled={locked}>
            {AUTH_LABELS.createLink}
          </LinkButton>
        </p>
      </Foot>
    </AuthCard>
  );
}

/** "By creating an account you agree to the Terms and Privacy Policy." with the pages this copy publishes. */
function AgreeLine({ legal }: { legal: LegalHrefs }) {
  const links: Array<{ href: string; label: string }> = [];
  if (legal.terms) links.push({ href: legal.terms, label: AUTH_LABELS.terms });
  if (legal.privacy) links.push({ href: legal.privacy, label: AUTH_LABELS.privacy });
  if (links.length === 0) return null;
  return (
    <p className="text-xs">
      {AUTH_LABELS.agreePrefix}{" "}
      {links.map((l, i) => (
        <Fragment key={l.href}>
          {i > 0 ? ` ${AUTH_LABELS.and} ` : null}
          <a href={l.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-neutral-800 dark:hover:text-neutral-200">
            {l.label}
            <span className="sr-only"> {AUTH_LABELS.newTab}</span>
          </a>
        </Fragment>
      ))}
      .
    </p>
  );
}

export function CreateView(props: {
  name: string;
  onName: (v: string) => void;
  email: string;
  onEmail: (v: string) => void;
  password: string;
  onPassword: (v: string) => void;
  busy: Busy;
  error: string | null;
  selfServeSignup: boolean;
  legal: LegalHrefs;
  onSubmit: () => void;
  onSignIn: () => void;
}) {
  const locked = props.busy !== null;
  return (
    <AuthCard title={AUTH_LABELS.createTitle} lead={props.selfServeSignup ? undefined : AUTH_MESSAGES.createListedOnly}>
      <Form onSubmit={props.onSubmit}>
        <TextField label={AUTH_LABELS.name} autoComplete="name" value={props.name} onChange={props.onName} disabled={locked} autoFocus />
        <EmailField value={props.email} onChange={props.onEmail} disabled={locked} />
        <PasswordField isNew value={props.password} onChange={props.onPassword} label={AUTH_LABELS.password} hint={AUTH_MESSAGES.passwordRule} disabled={locked} />
        <PrimaryButton busy={props.busy === "form"} busyLabel={AUTH_LABELS.creatingAccount} label={AUTH_LABELS.createAccount} disabled={locked} />
      </Form>
      <Messages error={props.error} />
      <Foot>
        <AgreeLine legal={props.legal} />
        <p>
          {AUTH_LABELS.haveAccount}{" "}
          <LinkButton onClick={props.onSignIn} disabled={locked}>
            {AUTH_LABELS.signIn}
          </LinkButton>
        </p>
      </Foot>
    </AuthCard>
  );
}

export function CodeView(props: {
  email: string;
  code: string;
  onCode: (v: string) => void;
  busy: Busy;
  error: string | null;
  notice?: string | null;
  /** Seconds until another code can be sent; 0 shows the Resend code button. */
  resendIn: number;
  selfServeSignup: boolean;
  /**
   * The address had too many wrong codes today (code_locked): no code field and no Resend code,
   * only Email me a link instead. The error says why (AUTH_MESSAGES.codeLocked).
   */
  codesLocked?: boolean;
  /**
   * A link was sent: the button becomes Send another link, and waits resendIn seconds first,
   * because a new link replaces the one on its way.
   */
  linkSent?: boolean;
  onSubmit: () => void;
  onResend: () => void;
  /** Emails a link that confirms the address in place of a code. */
  onEmailLink?: () => void;
  onStartAgain: () => void;
}) {
  const locked = props.busy !== null;
  const linkOnly = props.codesLocked === true && props.onEmailLink !== undefined;
  return (
    <AuthCard title={AUTH_LABELS.codeTitle} lead={linkOnly ? undefined : codeSentMessage(props.email)}>
      {linkOnly ? (
        props.linkSent === true && props.resendIn > 0 ? (
          <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">{sendLinkInMessage(props.resendIn)}</p>
        ) : (
          <Form onSubmit={props.onEmailLink!}>
            <PrimaryButton
              busy={props.busy === "form"}
              busyLabel={AUTH_LABELS.sending}
              label={props.linkSent === true ? AUTH_LABELS.sendAnotherLink : AUTH_LABELS.emailLinkInstead}
              disabled={locked}
            />
          </Form>
        )
      ) : (
        <Form onSubmit={props.onSubmit}>
          <CodeField value={props.code} onChange={props.onCode} disabled={locked} />
          <PrimaryButton busy={props.busy === "form"} busyLabel={AUTH_LABELS.confirming} label={AUTH_LABELS.confirmEmail} disabled={locked} />
        </Form>
      )}
      <Messages error={props.error} notice={props.notice} />
      <Foot>
        {linkOnly ? null : (
          <p>
            {props.resendIn > 0 ? (
              resendInMessage(props.resendIn)
            ) : (
              <LinkButton onClick={props.onResend} disabled={locked}>
                {AUTH_LABELS.resendCode}
              </LinkButton>
            )}
          </p>
        )}
        <p>
          {AUTH_LABELS.wrongAddress}{" "}
          <LinkButton onClick={props.onStartAgain} disabled={locked}>
            {AUTH_LABELS.startAgain}
          </LinkButton>
        </p>
        <p className="text-xs">{props.selfServeSignup ? AUTH_MESSAGES.codeHelpOpen : AUTH_MESSAGES.codeHelp}</p>
      </Foot>
    </AuthCard>
  );
}

export function ForgotView(props: {
  email: string;
  onEmail: (v: string) => void;
  busy: Busy;
  error: string | null;
  /** resetSentMessage once the link is asked for. */
  notice: string | null;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const locked = props.busy !== null;
  return (
    <AuthCard title={AUTH_LABELS.forgotTitle}>
      <Form onSubmit={props.onSubmit}>
        <EmailField value={props.email} onChange={props.onEmail} disabled={locked} autoFocus />
        <PrimaryButton busy={props.busy === "form"} busyLabel={AUTH_LABELS.sending} label={AUTH_LABELS.sendResetLink} disabled={locked} />
      </Form>
      <Messages error={props.error} notice={props.notice} />
      <Foot>
        <p>
          <LinkButton onClick={props.onBack} disabled={locked}>
            {AUTH_LABELS.backToSignIn}
          </LinkButton>
        </p>
      </Foot>
    </AuthCard>
  );
}

/** After the door removed an account it couldn't trust (the browser is signed out already). */
export function SignInAgainView({ onContinue }: { onContinue: () => void }) {
  return (
    <AuthCard title={AUTH_MESSAGES.signInAgainTitle} lead={AUTH_MESSAGES.signInAgainBody}>
      <button type="button" onClick={onContinue} className={PRIMARY_BUTTON_CLASS} autoFocus>
        {AUTH_LABELS.signIn}
      </button>
    </AuthCard>
  );
}
