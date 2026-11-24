import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { AUTH_LABELS, AUTH_MESSAGES, PASSWORD_MIN_LENGTH, SIGN_IN_SECURITY_COPY } from "@/lib/auth/messages";

/**
 * /help/sign-in-and-passwords: signing in with an email and a password (PASSWORD_SIGNIN_ENABLED;
 * the page is listed and served only while it is on). Every button and message it names comes from
 * src/lib/auth/messages.ts, so it says what the screens say.
 */

const SETTINGS = "/admin/account/settings";
const SECURITY_CARD = SIGN_IN_SECURITY_COPY.title;
const CHANGE_PASSWORD = SIGN_IN_SECURITY_COPY.changePassword;
const CURRENT_PASSWORD = SIGN_IN_SECURITY_COPY.currentPassword;
const SIGN_OUT_EVERYWHERE = SIGN_IN_SECURITY_COPY.signOutEverywhere;

export default function SignInAndPasswordsHelp() {
  return (
    <article>
      <H1>Sign in and passwords</H1>
      <Lead>
        Sign in to YouGrow with Google, or with your email address and a password. This page covers the password: who can
        use one, creating your account, the code we email you, forgetting or changing your password, and signing out of every
        device at once.
      </Lead>
      <Meta items={["About 3 minutes", "Everyone on the team", "Once, then when you need it"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Your own email address on your team&apos;s admin list (ask whoever runs your YouGrow)</li>
            <li>That address&apos;s inbox open, for a 6-digit code</li>
          </>
        }
        unlocks={
          <>
            <li>Signing in without a Google account</li>
            <li>Changing your password, and signing out on every device from one place</li>
          </>
        }
      />

      <H2 id="who">Who can use a password</H2>
      <P>
        Anyone whose exact email address is on your team&apos;s admin list. A team can also let in everyone at its own
        domain, but that works with <strong>{AUTH_LABELS.google}</strong> only: if your address gets in that way, sign in
        with Google, or ask whoever runs your YouGrow to add your address itself.
      </P>

      <H2 id="create">Create your account</H2>
      <Steps>
        <li>
          Open the <Open href="/login">sign-in page</Open>. Under <strong>{AUTH_LABELS.firstTime}</strong>, press{" "}
          <strong>{AUTH_LABELS.createLink}</strong>.
        </li>
        <li>
          Fill in <strong>{AUTH_LABELS.name}</strong>, <strong>{AUTH_LABELS.email}</strong> and a{" "}
          <strong>{AUTH_LABELS.password}</strong> of at least {PASSWORD_MIN_LENGTH} characters. Press{" "}
          <strong>{AUTH_LABELS.show}</strong> to check what you typed.
        </li>
        <li>
          Press <strong>{AUTH_LABELS.createAccount}</strong>. We email you a 6-digit code.
        </li>
        <li>
          Type the code under <strong>{AUTH_LABELS.code}</strong> and press <strong>{AUTH_LABELS.confirmEmail}</strong>.
          You land in your brand.
        </li>
      </Steps>

      <H2 id="code">The code</H2>
      <P>
        The code proves the address is yours. Type it into the page that asked for it, within 10 minutes. Five wrong tries
        end it, and a new code replaces the one before.
      </P>
      <P>
        No email? Check your spam folder, then press <strong>{AUTH_LABELS.resendCode}</strong> (it waits 30 seconds between
        codes). Typed the wrong address? Press <strong>{AUTH_LABELS.startAgain}</strong>. If you closed the page, sign in
        with your email and password: we send you a new code.
      </P>
      <P>
        If your address isn&apos;t on the admin list, no code is sent, and the page doesn&apos;t say so. That keeps the list
        private. Ask your admin to add your address, then press <strong>{AUTH_LABELS.resendCode}</strong>.
      </P>

      <H2 id="link">{AUTH_LABELS.emailLinkInstead}</H2>
      <P>
        After 15 wrong codes for one address in a day, codes stop for that address for a day, whoever typed them. The code
        screen then offers <strong>{AUTH_LABELS.emailLinkInstead}</strong>. Open the link in the email within 30 minutes, in
        a browser where you&apos;re signed in to YouGrow with that address. If you aren&apos;t, the page asks for your email
        and password first. The link works once, and only for your own account. A new link replaces the one before, so
        the screen waits 30 seconds before it offers <strong>{AUTH_LABELS.sendAnotherLink}</strong>: give the first one a
        moment to arrive.
      </P>

      <H2 id="forgot">Forgot your password</H2>
      <Steps>
        <li>
          Press <strong>{AUTH_LABELS.forgotPassword}</strong> on the sign-in page.
        </li>
        <li>
          Enter your email and press <strong>{AUTH_LABELS.sendResetLink}</strong>. You get the same answer whether or not
          there&apos;s an account for the address, so nobody can use it to find out who has one.
        </li>
        <li>Open the link in the email. {AUTH_MESSAGES.resetLinkOnce}</li>
        <li>
          Type a <strong>{AUTH_LABELS.newPassword}</strong> and press <strong>{AUTH_LABELS.savePassword}</strong>. Then sign
          in with it.
        </li>
      </Steps>

      <H2 id="change">Change your password</H2>
      <Steps>
        <li>
          Open <Open href={SETTINGS}>Settings</Open> and find <strong>{SECURITY_CARD}</strong>. It shows how you sign in:
          Password, Google or both.
        </li>
        <li>
          Press <strong>{CHANGE_PASSWORD}</strong>, type your <strong>{CURRENT_PASSWORD}</strong> and a{" "}
          <strong>{AUTH_LABELS.newPassword}</strong>, and press <strong>{AUTH_LABELS.savePassword}</strong>.
        </li>
      </Steps>
      <P>
        You stay signed in here, and every other device is signed out. {CHANGE_PASSWORD} shows only for accounts that sign in
        with a password: if you use Google only, your Google account&apos;s password is the one to change.
      </P>

      <H2 id="everywhere">Sign out everywhere</H2>
      <P>
        Left YouGrow signed in on a shared or lost computer? In <Open href={SETTINGS}>Settings</Open>, under{" "}
        <strong>{SECURITY_CARD}</strong>, press <strong>{SIGN_OUT_EVERYWHERE}</strong>, then{" "}
        <strong>{SIGN_IN_SECURITY_COPY.signOutEverywhereYes}</strong> to confirm. Every device is signed out,
        including this one, and you go back to the sign-in page. Signing in again works as before.
      </P>

      <H2 id="sign-in-again">What &quot;{AUTH_MESSAGES.signInAgainTitle}&quot; means</H2>
      <P>
        You may see this the first time you sign in. YouGrow checks a new account before it lets it in. If someone else
        started a sign-up with your address before you did, it can&apos;t tell whose account it is, so it removes it. Nothing
        of yours was in it: you lose nothing.
      </P>
      <P>
        Sign in again. If you used a password, create your account again: you get a new code to confirm the address is
        yours. Seeing it again and again? Tell whoever runs your YouGrow.
      </P>

      <H2 id="self-host">Running your own copy</H2>
      <P>
        Password sign-in is off until whoever runs your copy turns it on. It needs Identity Platform set up for passwords, an
        email provider for the codes, and its switch. The self-host guide in the source code (<code>docs/self-host.md</code>,
        under &quot;Email and password sign-in&quot;) explains each step, with one command that does most of them. Start
        from <Open href="/developers/open-source#host">Host your own copy</Open>.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>The sign-in page shows email and password fields under {AUTH_LABELS.google}.</li>
        <li>
          After the code, <Open href={SETTINGS}>Settings</Open> shows Password under how you sign in.
        </li>
        <li>A reset link from {AUTH_LABELS.forgotPassword} reaches your inbox.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [AUTH_MESSAGES.wrongPassword, <>Check the address and password. Forgot it? Press {AUTH_LABELS.forgotPassword} on the sign-in page.</>],
          [AUTH_MESSAGES.tooManyTries, <>Wait a few minutes before you try again, or reset your password.</>],
          [AUTH_MESSAGES.googleOnly, <>Your address gets in through your team&apos;s domain, which works with Google only. Ask your admin to add your own address to use a password.</>],
          [AUTH_MESSAGES.emailInUse, <>You already have an account. Sign in, or press {AUTH_LABELS.forgotPassword} on the sign-in page.</>],
          [AUTH_MESSAGES.usePasswordInstead, <>This address already has a password. Sign in with it, or reset it.</>],
          [AUTH_MESSAGES.emailNotConfirmed, <>Type the code from the email. See <Open href="/help/sign-in-and-passwords#code">The code</Open>.</>],
          [AUTH_MESSAGES.codeHelp, <>No code came: your address may not be on the admin list yet. Ask your admin to add it.</>],
          [AUTH_MESSAGES.codeWrong, <>Check the latest email: a new code replaces the one before.</>],
          [AUTH_MESSAGES.codeExpired, <>Press {AUTH_LABELS.resendCode} and type the new code within 10 minutes.</>],
          [AUTH_MESSAGES.codeTooMany, <>Press {AUTH_LABELS.resendCode} for a new code.</>],
          [AUTH_MESSAGES.codeRateLimited, <>Wait a few minutes, then ask for one more code.</>],
          [AUTH_MESSAGES.codeLocked, <>Press {AUTH_LABELS.emailLinkInstead}. See <Open href="/help/sign-in-and-passwords#link">{AUTH_LABELS.emailLinkInstead}</Open>.</>],
          [AUTH_MESSAGES.linkRateLimited, <>Wait a few minutes, then press {AUTH_LABELS.emailLinkInstead} again. Codes and links together are limited to 6 an hour for each address.</>],
          [AUTH_MESSAGES.linkUnavailable, <>Whoever runs your copy hasn&apos;t set its web address for links. Ask them, or wait a day and use a code.</>],
          [AUTH_MESSAGES.confirmSignIn, <>The link works only in a browser signed in to your account. Type the email and password you created it with.</>],
          [AUTH_MESSAGES.linkInvalid, <>Use the newest link, within 30 minutes, signed in with the address it was sent to. Or sign in and press {AUTH_LABELS.emailLinkInstead} for a new one.</>],
          [AUTH_MESSAGES.linkReopen, <>The page takes the link out of the address bar, so reloading it loses the link. Open the link in the email again.</>],
          [AUTH_MESSAGES.resetLinkBad, <>Press {AUTH_LABELS.forgotPassword} on the sign-in page again, and use the newest email.</>],
          [AUTH_MESSAGES.resetLinkWrongMode, <>Press {AUTH_LABELS.forgotPassword} on the sign-in page for a new reset link.</>],
          [AUTH_MESSAGES.recoverLinkBad, <>You opened an older email telling you your sign-in email changed. If you didn&apos;t change it, your admin can put it back.</>],
          [AUTH_MESSAGES.resetLinkReopen, <>The page takes the link out of the address bar, so reloading it loses the link. Open the link in the email again; it works until it is used or an hour has passed.</>],
          [AUTH_MESSAGES.passwordChangedSignInAgain, <>Your new password is saved, but this tab couldn&apos;t stay signed in. Sign out, then sign in with the new password.</>],
          [AUTH_MESSAGES.passwordChangedUseGoogle, <>Your new password is saved, but your address gets in through your team&apos;s domain, which works with Google only. Sign out, then use {AUTH_LABELS.google}.</>],
          [AUTH_MESSAGES.currentPasswordWrong, <>Type the password you sign in with now. Forgot it? Sign out, then press {AUTH_LABELS.forgotPassword} on the sign-in page.</>],
          [AUTH_MESSAGES.passwordRulesNotMet, <>Try a longer password with a mix of letters, numbers and symbols.</>],
          [AUTH_MESSAGES.passwordNeedsReset, <>Press {AUTH_LABELS.forgotPassword} on the sign-in page and choose a new password.</>],
          [AUTH_MESSAGES.passwordUnavailable, <>Sign in with Google for now, or try again in a few minutes.</>],
          [AUTH_MESSAGES.passwordSigninOff, <>Whoever runs your copy hasn&apos;t turned password sign-in on. Use {AUTH_LABELS.google}.</>],
          [AUTH_MESSAGES.signInAgainTitle, <>See <Open href="/help/sign-in-and-passwords#sign-in-again">Please sign in again</Open>.</>],
          [AUTH_MESSAGES.googleAddressChanged, <>Your team renamed your Google address. Moving your account to it signs you out on every device, so press {AUTH_LABELS.google} once more. Your brands and settings stay as they were.</>],
        ]}
      />

      <NextPage slug="sign-in-and-passwords" />
    </article>
  );
}
