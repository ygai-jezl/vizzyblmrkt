/**
 * Every message people read while signing in with a password, in one place so the screens,
 * the API and the help page (src/components/help/pages/sign-in-and-passwords.tsx) quote the
 * same words. Copy follows src/lib/content/writingRules.ts: no dashes as punctuation, no AI tells.
 */

export const PASSWORD_MIN_LENGTH = 12;

export const AUTH_MESSAGES = {
  passwordTooShort: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  passwordRule: `At least ${PASSWORD_MIN_LENGTH} characters.`,
  emailLooksWrong: "Enter an email address like name@example.com.",
  nameMissing: "Enter your name.",
  wrongPassword: "That email and password don't match. Try again, or reset your password.",
  tooManyTries: "Too many tries. Wait a few minutes, or reset your password.",
  emailInUse: "There's already an account for this address. Sign in, or reset your password.",
  usePasswordInstead:
    "This address already signs in with a password. Use your email and password, or reset your password.",
  passwordUnavailable:
    "Password sign-in isn't available right now. Try again in a few minutes, or sign in with Google.",
  googleOnly: "Your team signs in with Google. Use Sign in with Google.",
  emailNotConfirmed: "Confirm your email first. We've sent you a code.",
  codeHelp: "The code works for 10 minutes. Not getting one? Ask your admin to add this address.",
  codeWrong: "That code isn't right. Check the email and try again.",
  codeExpired: "That code has expired. Send a new one.",
  codeTooMany: "Too many wrong codes. Send a new one.",
  codeRateLimited: "You've asked for a lot of codes. Wait a few minutes, then try again.",
  resetLinkBad: "This reset link has expired or was already used. Ask for a new one.",
  resetLinkWrongMode: "YouGrow doesn't use this kind of link. Ask for a new password reset instead.",
  resetDone: "Your password is saved. Sign in with it now.",
  signInAgainTitle: "Please sign in again",
  signInAgainBody:
    "Someone else may have started a sign-up with your address before you, so we removed it to keep your account safe. You have lost nothing. Sign in again, or create your account again if you used a password.",
  currentPasswordWrong: "Your current password isn't right.",
  passwordChanged: "Password changed. You're signed out on your other devices.",
  somethingWentWrong: "Something went wrong. Try again.",
  passwordRulesNotMet:
    "That password doesn't meet the password rules here. Try a longer one with a mix of letters, numbers and symbols.",
  passwordNeedsReset: "Your password no longer meets the password rules. Reset it to sign in.",
  accountDisabled: "This account is turned off. Ask your admin for help.",
  popupBlocked: "Your browser blocked the Google window. Allow pop-ups for this site, then try again.",
  tooManyTriesWait: "Too many tries. Wait a few minutes, then try again.",
  codeIncomplete: "Enter all 6 digits from the email.",
  codeHelpOpen: "The code works for 10 minutes. Not getting one? Check your spam folder, or send a new one.",
  createListedOnly: "You can create an account once your admin has added your address.",
  resetLinkOnce: "This link works once and expires after an hour.",
  passwordSigninOff: "Password sign-in is off in this copy of YouGrow. Sign in with Google instead.",
  passwordMissing: "Enter your password.",
  codeResent: "We've sent a new code.",
  passwordChangedSignInAgain: "Password changed. Sign in again here with your new password.",
  passwordChangedUseGoogle: "Password changed. Your team signs in with Google, so sign in again here with Google.",
  resetLinkReopen: "Open the reset link from your email again to choose a new password.",
  recoverAdvice:
    "If you didn't ask for that change, someone else may know your password. Reset it now, then use Sign out everywhere in Settings.",
  recoverLinkBad: "This link has expired or was already used. If your sign-in email was changed without you, ask your admin for help.",
  codeLocked: "Too many wrong codes have been typed for this address today, so codes are paused. We can email you a link instead.",
  linkInvalid:
    "This link has expired, was already used, or is for another account. Sign in with the address it was sent to, or ask for a new link.",
  linkUnavailable: "This copy of YouGrow can't send links yet. Ask your admin for help, or try a code again tomorrow.",
  confirmSignIn: "Sign in to finish confirming your email.",
  linkRateLimited: "You've asked for a lot of emails. Wait a few minutes, then try again.",
  linkReopen: "Open the link from your email again to finish confirming your email.",
  googleAddressChanged:
    "Your Google address changed, so we moved your YouGrow account to the new one. Sign in with Google again to get in.",
} as const;

export type AuthMessageKey = keyof typeof AUTH_MESSAGES;

/** "Enter the 6-digit code we sent to …" on the code screen. */
export function codeSentMessage(email: string): string {
  return `Enter the 6-digit code we sent to ${email}.`;
}

/** The answer after "Send reset link", the same whether or not the address has an account. */
export function resetSentMessage(email: string): string {
  return `If there's an account for ${email}, a reset link is on its way. Check your spam folder too.`;
}

/** "Resend code in 0:28" while the code screen waits before it offers another code. */
export function resendInMessage(seconds: number): string {
  return `Resend code in ${minutesAndSeconds(seconds)}`;
}

/** 28 seconds as "0:28". */
function minutesAndSeconds(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** After an "undo the email change" link: the address the account signs in with again. */
export function recoverDoneMessage(email: string): string {
  return `Your sign-in email is back to ${email}.`;
}

/** "For alex@example.com" under "Choose a new password", once the reset link checks out. */
export function resetForMessage(email: string): string {
  return `For ${email}`;
}

/**
 * The fixed words on the sign-in screens (headings, field labels, buttons and links), so the help
 * page can quote them too. Same copy rules as AUTH_MESSAGES.
 */
export const AUTH_LABELS = {
  brand: "YouGrow",
  signInTitle: "Sign in",
  createTitle: "Create your account",
  codeTitle: "Check your email",
  forgotTitle: "Reset your password",
  resetTitle: "Choose a new password",
  recoverTitle: "Your sign-in email",
  google: "Sign in with Google",
  or: "or",
  name: "Your name",
  email: "Email",
  password: "Password",
  newPassword: "New password",
  code: "6-digit code",
  show: "Show",
  hide: "Hide",
  showPassword: "Show password",
  hidePassword: "Hide password",
  signIn: "Sign in",
  signingIn: "Signing in…",
  createAccount: "Create account",
  creatingAccount: "Creating your account…",
  forgotPassword: "Forgot password?",
  firstTime: "First time with a password?",
  createLink: "Create your account",
  haveAccount: "Already have an account?",
  backToSignIn: "Back to sign in",
  confirmEmail: "Confirm email",
  confirming: "Confirming…",
  resendCode: "Resend code",
  wrongAddress: "Wrong address?",
  startAgain: "Start again",
  sendResetLink: "Send reset link",
  sending: "Sending…",
  savePassword: "Save password",
  saving: "Saving…",
  checkingLink: "Checking your link…",
  tryAgain: "Try again",
  agreePrefix: "By creating an account you agree to the",
  terms: "Terms",
  privacy: "Privacy Policy",
  and: "and",
  newTab: "(opens in a new tab)",
  emailLinkInstead: "Email me a link instead",
  sendAnotherLink: "Send another link",
  confirmTitle: "Confirm your email",
} as const;

/**
 * The "Sign-in and security" card on Settings › General (src/components/admin/SignInSecurityCard.tsx).
 * Field labels and buttons shared with the sign-in screens are AUTH_LABELS.
 */
export const SIGN_IN_SECURITY_COPY = {
  title: "Sign-in and security",
  howYouSignIn: "How you sign in",
  signInAgainToSee: "Sign out and sign in again to see this here.",
  password: "Password",
  passwordNote: "Changing it signs you out on your other devices.",
  changePassword: "Change password",
  currentPassword: "Current password",
  cancel: "Cancel",
  devices: "Devices",
  devicesNote: "Signs out everywhere, including here.",
  signOutEverywhere: "Sign out everywhere",
  signOutEverywhereConfirm: "Sign out on every device, this one included? You'll need to sign in again everywhere.",
  signOutEverywhereYes: "Yes, sign out everywhere",
  signingOut: "Signing out…",
  loading: "Loading…",
} as const;

/**
 * The email that carries the 6-digit code (src/lib/auth/emailCode.ts). It holds the code and
 * these fixed words only, nothing the account holder typed.
 */
export const EMAIL_CODE_EMAIL = {
  subject: (code: string) => `${code} is your YouGrow code`,
  title: "Your YouGrow code",
  intro: (code: string) => `Your YouGrow code is ${code}.`,
  introHtml: "Your YouGrow code is:",
  use: (minutes: number) => `Enter it to confirm your email address. It works for ${minutes} minutes.`,
  ignore: "Don't share this code with anyone. If you didn't ask for it, someone may have typed your address: ignore this email.",
} as const;

/** "Send another link in 0:28" while the code screen waits before it offers another link. */
export function sendLinkInMessage(seconds: number): string {
  return `Send another link in ${minutesAndSeconds(seconds)}`;
}

/** After "Email me a link instead": where the link went and how long it works. */
export function linkSentMessage(email: string): string {
  return `We've sent a link to ${email}. Open it within 30 minutes to confirm your email.`;
}

/**
 * The email that carries the link to /login/confirm (src/lib/auth/emailCode.ts), sent in place of
 * a code once the address is locked. It holds the link and these fixed words only, nothing the
 * account holder typed.
 */
export const EMAIL_LINK_EMAIL = {
  subject: "Confirm your YouGrow email",
  title: "Confirm your YouGrow email",
  intro: "Press the button to confirm your email address for YouGrow.",
  /** The text part's intro: a text-only mail client shows no button, only the link under it. */
  textIntro: "Open this link to confirm your email address for YouGrow:",
  button: "Confirm email",
  plain: "Or copy this link into your browser:",
  use: (minutes: number) => `It works once, for ${minutes} minutes, in a browser where you're signed in to YouGrow with this address.`,
  ignore: "If you didn't ask for this, ignore this email.",
} as const;
