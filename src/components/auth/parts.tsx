"use client";

import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { AUTH_LABELS, PASSWORD_MIN_LENGTH } from "@/lib/auth/messages";

/**
 * The pieces every sign-in screen shares, styled like the Google-only sign-in page: a centred
 * narrow column, the small YouGrow label, neutral colours with their dark mode pairs.
 */

export const INPUT_CLASS =
  "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

export const PRIMARY_BUTTON_CLASS =
  "w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200";

export const LINK_CLASS =
  "font-medium text-neutral-700 underline underline-offset-4 hover:text-neutral-900 disabled:opacity-60 dark:text-neutral-300 dark:hover:text-white";

/** Safari's password generator reads this: make new passwords at least the minimum length. */
const PASSWORD_RULES_ATTR: Record<string, string> = { passwordrules: `minlength: ${PASSWORD_MIN_LENGTH};` };

/** The page frame: YouGrow, the screen's heading, an optional line under it, then the screen. */
export function AuthCard({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div className="space-y-1 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">{AUTH_LABELS.brand}</p>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {lead ? <p className="pt-1 text-sm text-neutral-500 dark:text-neutral-400">{lead}</p> : null}
      </div>
      {children}
    </main>
  );
}

/** Google's four colour G, as on the Google-only sign-in page. */
export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.98 10.72A5.4 5.4 0 0 1 3.7 9c0-.6.1-1.18.28-1.72V4.94H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.06l3.02-2.34Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.94L3.98 7.28C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

export function GoogleButton({ onClick, busy, disabled }: { onClick: () => void; busy: boolean; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-center gap-3 rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
    >
      <GoogleMark />
      {busy ? AUTH_LABELS.signingIn : AUTH_LABELS.google}
    </button>
  );
}

/** The "or" rule between Google and the email form. */
export function OrRule() {
  return (
    <div className="flex items-center gap-3 text-xs text-neutral-500">
      <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" aria-hidden />
      {AUTH_LABELS.or}
      <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" aria-hidden />
    </div>
  );
}

/**
 * Errors and notices as people see them; empty, it takes back the column's gap. Screen readers
 * hear them through LiveRegion, not here: each screen mounts its own copy of this, and a live
 * region that arrives already filled (a message set with a change of screen) isn't read out.
 */
export function Messages({ error, notice }: { error: string | null; notice?: string | null }) {
  return (
    <div className="space-y-2 text-center text-sm empty:-mt-6">
      {error ? <p className="text-red-600 dark:text-red-400">{error}</p> : null}
      {notice ? (
        <p className="rounded-md border border-neutral-300 px-3 py-2.5 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What screen readers hear as it changes. A page renders one, outside its screens, so it stays
 * mounted while the screens change round it and every new message is read out, including one set
 * together with a change of screen.
 */
export function LiveRegion({ message }: { message: string }) {
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}

/** The words for LiveRegion from a screen's error and notice. */
export function liveMessage(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(" ");
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
      {children}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  autoComplete,
  type = "text",
  disabled,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  type?: "text" | "email";
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        name={autoComplete === "email" ? "email" : autoComplete}
        type={type}
        inputMode={type === "email" ? "email" : undefined}
        autoComplete={autoComplete}
        autoCapitalize={type === "email" ? "none" : undefined}
        spellCheck={false}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
        className={INPUT_CLASS}
      />
    </div>
  );
}

export function EmailField(props: { value: string; onChange: (value: string) => void; disabled?: boolean; autoFocus?: boolean }) {
  return <TextField label={AUTH_LABELS.email} type="email" autoComplete="email" {...props} />;
}

/**
 * A password field with a Show/Hide button. A new password says the length rule under it, carries
 * Safari's passwordrules, and asks the browser's password manager to suggest one.
 */
export function PasswordField({
  value,
  onChange,
  isNew,
  label = isNew ? AUTH_LABELS.newPassword : AUTH_LABELS.password,
  hint,
  labelAside,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  isNew: boolean;
  label?: string;
  hint?: string;
  labelAside?: ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [shown, setShown] = useState(false);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {labelAside}
      </div>
      <div className="relative">
        <input
          id={id}
          name={isNew ? "new-password" : "password"}
          type={shown ? "text" : "password"}
          autoComplete={isNew ? "new-password" : "current-password"}
          autoCapitalize="none"
          spellCheck={false}
          required
          minLength={isNew ? PASSWORD_MIN_LENGTH : undefined}
          aria-describedby={hint ? hintId : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoFocus={autoFocus}
          className={`${INPUT_CLASS} pr-16`}
          {...(isNew ? PASSWORD_RULES_ATTR : {})}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-controls={id}
          aria-pressed={shown}
          aria-label={shown ? AUTH_LABELS.hidePassword : AUTH_LABELS.showPassword}
          className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          {shown ? AUTH_LABELS.hide : AUTH_LABELS.show}
        </button>
      </div>
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The 6-digit code: one field, digits only, filled in from the email by phones that can. */
export function CodeField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div>
      <FieldLabel htmlFor={id}>{AUTH_LABELS.code}</FieldLabel>
      <input
        id={id}
        name="one-time-code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        // No maxLength: the browser would cut a pasted " 123456" or "is 123456." before
        // onChange could keep its digits. onChange keeps at most 6 digits itself.
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus
        className={`${INPUT_CLASS} text-center font-mono text-xl tracking-[0.5em]`}
      />
    </div>
  );
}

const noSubscribe = () => () => undefined;

/**
 * False in the server's HTML and while React hydrates it, true once React runs the page. Until
 * then a form has no submit handler, and the browser would send it itself, as a GET with the
 * password in the address.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

/**
 * The form's submit button. It stays disabled until the page is hydrated: a disabled default
 * button also stops Enter from sending the form, so nothing goes out before our handler is there.
 */
export function PrimaryButton({ busy, busyLabel, label, disabled }: { busy: boolean; busyLabel: string; label: string; disabled?: boolean }) {
  const hydrated = useHydrated();
  return (
    <button type="submit" disabled={!hydrated || (disabled ?? busy)} className={PRIMARY_BUTTON_CLASS}>
      {busy ? busyLabel : label}
    </button>
  );
}

/** A small link-styled button that switches screens. */
export function LinkButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={LINK_CLASS}>
      {children}
    </button>
  );
}
