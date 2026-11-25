import { H1, H2, H3, Lead, P, UL } from "@/components/developers/Doc";
import { Messages, NextPage, Open, Warning } from "@/components/help/blocks";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { isOnboardingEnabled, isOnboardingVoiceEnabled } from "@/lib/onboarding/flags";
import { ABOUT_WORDS, BASICS_WORDS, COMING_UP_WORDS, FACT_WORDS, HOME_WORDS, SUGGESTION_WORDS, VOICE_WORDS, WELCOME_WORDS } from "@/lib/onboarding/words";
import type { HelpBodyProps } from "@/lib/help/pages";

/**
 * The /help hub: the five setup stages in order, and where the order matters. With ideas in the
 * words (`ideaWords`) stage 2 is Idea, as Home calls it; its anchor stays #launch, and stage 4 stays
 * Launch product. With getting to know a new brand on (`onboarding`), #about-you says what the
 * welcome asks, and Home starts where the brand is rather than at stage 1. With voice too
 * (`onboardingVoice`), it says how Talk with Vizzy works, what is kept and what isn't, and how
 * Here's what I learned works after a call. It also says where to change the answers later (Settings,
 * About your business) and how they order Home's Your next action, what Vizzy reads in every chat,
 * and how something new Vizzy hears in a later chat waits for an admin's Keep. #sidebar says how the
 * sidebar's Coming up works for a brand that answered on the welcome.
 */
export default function GetSetUpHelp({
  ideaWords = isIdeaWordsEnabled(),
  onboarding = isOnboardingEnabled(),
  onboardingVoice = isOnboardingVoiceEnabled(),
}: HelpBodyProps = {}) {
  return (
    <article>
      <H1>Get set up</H1>
      <Lead>
        {onboarding
          ? "Five stages. Home shows where you are and your next action."
          : "Five stages, in order. Each one unlocks the next. Home shows where you are and what to do next."}
      </Lead>

      <H2 id="brand">First, your brand</H2>
      <P>
        Everything in YouGrow belongs to a brand. Make one from the brand switcher at the top of the sidebar with{" "}
        <strong>Add Brand</strong>, or <Open href="/admin/brands/new">here</Open>. You need its name, your website (such as
        yourbrand.com) and a <strong>Data region</strong>. The region is where its data lives, and it can&apos;t be changed
        later.
      </P>

      {onboarding ? (
        <>
          <H2 id="about-you">Tell Vizzy about your business</H2>
          {onboardingVoice ? (
            <P>
              The first time an admin opens Home for a new brand, YouGrow opens a welcome page. Choose{" "}
              <strong>{WELCOME_WORDS.talk}</strong> to talk it through by voice in 3 to 5 minutes, or answer 4 quick questions
              instead. <strong>Skip for now</strong> goes straight to Home. It shows once per brand. Members don&apos;t see it,
              and a brand that already has something in it never gets it.
            </P>
          ) : (
            <P>
              The first time an admin opens Home for a new brand, YouGrow opens a welcome page. Choose{" "}
              <strong>Answer 4 quick questions</strong>, or <strong>Skip for now</strong> to go straight to Home. It shows
              once per brand. Members don&apos;t see it, and a brand that already has something in it never gets it.
            </P>
          )}
          <P>
            The questions ask who you are, what you run, where it is today and what you want from YouGrow first. Each answer
            saves as soon as you pick it, so closing the page keeps what you picked. Press 1, 2 or 3 to pick from the keyboard,{" "}
            <strong>Skip</strong> to leave a question blank, or <strong>Back</strong> to change the one before.
          </P>
          <P>
            After the fourth, <strong>That&apos;s all four</strong> lists your answers. Choose{" "}
            <strong>See your next action</strong> to go to Home.
          </P>
          {onboardingVoice ? (
            <>
              <P>
                Your browser asks to use your microphone the first time. Vizzy listens only on the welcome page. During the
                call, Vizzy makes sure it hears who you are, what you run, where it is today and what you want first, and
                ticks each one off as you talk. Talk about anything else too. <strong>{VOICE_WORDS.mute}</strong> stops sending
                your voice, and <strong>{VOICE_WORDS.end}</strong> finishes the call. It ends by itself after 5 minutes.
              </P>
              <P>
                Vizzy keeps the words, never the audio. Your voice goes to Google&apos;s Gemini API for the call and isn&apos;t
                stored. The transcript stays with your brand until you delete it in Settings, under About your business. Each
                brand has one call a day.
              </P>
              <Messages
                rows={[
                  [VOICE_WORDS.blocked, "Allow the microphone for this site in your browser, then open the welcome again."],
                  [VOICE_WORDS.usedToday, "Answer the 4 quick questions now, or talk with Vizzy tomorrow (UTC)."],
                  [VOICE_WORDS.full, "Delete a conversation you no longer need in Settings, under About your business."],
                  [VOICE_WORDS.unavailable, "Answer the 4 quick questions, or try again later."],
                  [VOICE_WORDS.dropped, "Choose See what I learned: Vizzy works from the words you said before it dropped."],
                ]}
              />
            </>
          ) : null}
          {onboardingVoice ? (
            <P>
              After a call with Vizzy, <strong>Here&apos;s what I learned</strong> shows the four answers and what else Vizzy
              heard, each with your own words. Change an answer, or <strong>Remove</strong> anything that&apos;s off (
              <strong>Undo</strong> brings it back). <strong>Read the transcript</strong> shows the whole conversation. Nothing
              is saved until you choose <strong>Looks right</strong>.
            </P>
          ) : null}
          <P>
            Change your answers any time in <Open href="/admin/account/settings">Settings › General</Open>, under{" "}
            <strong>{ABOUT_WORDS.title}</strong>. Each one saves as soon as you pick it, and a question you skipped reads{" "}
            <strong>{BASICS_WORDS.notPicked}</strong> until you answer it. Only admins see it.
          </P>
          {onboardingVoice ? (
            <P>
              It also lists what Vizzy learned, each with your own words. <strong>{FACT_WORDS.remove}</strong> takes one out for
              good. Under Conversations, <strong>{ABOUT_WORDS.view}</strong> reads a call again and{" "}
              <strong>{ABOUT_WORDS.delete}</strong> removes its transcript for good. What Vizzy learned from it stays until you
              remove it. <strong>{ABOUT_WORDS.talkAgain}</strong> opens the welcome for another call.
            </P>
          ) : null}
          <P>
            Vizzy reads your answers and the facts you kept in every chat, so its answers fit your business. When a member
            chats with Vizzy, it reads the four answers only.
          </P>
          <P>
            When you tell Vizzy something new about the business in a later chat, such as a deadline, a channel or a goal, it
            reads it back and asks before it adds it. It then waits at the top of <strong>{ABOUT_WORDS.learned}</strong>,
            marked &quot;{SUGGESTION_WORDS.waiting("25 Nov")}&quot;, and in Review. <strong>{SUGGESTION_WORDS.keep}</strong>{" "}
            adds it, with the chat under Conversations, and <strong>{FACT_WORDS.remove}</strong> drops it. Vizzy uses it only
            once an admin keeps it, and one nobody decides goes after 30 days.
          </P>
          <Messages
            rows={[
              [SUGGESTION_WORDS.full, `Remove a fact you no longer need under ${ABOUT_WORDS.learned}, then press Keep again.`],
              [SUGGESTION_WORDS.decided, "Another admin decided it a moment ago. Refresh Settings to see where it went."],
            ]}
          />
          <P>
            Home&apos;s <strong>{HOME_WORDS.nextAction}</strong> starts with the stage that fits your answers: the waitlist
            first for an idea, content first when you want an audience, and your product first for an app that wants
            customers. A shop or a service never starts with connecting an app. With no answers, it starts at the first stage
            not done.
          </P>

          <H2 id="sidebar">What the sidebar shows</H2>
          <P>
            When you tell Vizzy about your business on the welcome, the sidebar starts with the sections that fit it. Home,
            Review, {ideaWords ? "Ideas" : "Launches"}, Brand and Settings always show. The rest wait under{" "}
            <strong>{COMING_UP_WORDS.title}</strong>, each with a line on when it comes in.
          </P>
          <P>
            <strong>{COMING_UP_WORDS.openEarly}</strong> shows one now, and it stays. A section also shows by itself once it has
            something of yours in it, or once you open its page another way, and nothing that shows is ever hidden again. ⌘K
            (Ctrl K on Windows) finds every section, shown or not.
          </P>
          <P>
            If you skip the welcome, or answer only in Settings, you see every section as before. Changing an answer later only
            ever adds sections.
          </P>
        </>
      ) : null}

      <H2 id="ready">1. Get ready</H2>
      <P>About 30 minutes plus DNS time, once per brand. Do this before anything goes out.</P>
      <UL>
        <li>
          <Open href="/help/email-sending#domain">Verify your sending domain</Open>
        </li>
        <li>
          <Open href="/help/email-sending#sender">Add your sender details</Open>: From address, privacy policy link and postal
          address
        </li>
        <li>
          <Open href="/help/your-brand#logo">Add your logo</Open> and{" "}
          <Open href="/help/your-brand#voice">set your brand voice</Open>
        </li>
        <li>
          <Open href="/help/email-style">Style your emails</Open>
        </li>
      </UL>

      <H2 id="launch">{ideaWords ? "2. Idea" : "2. Launch"}</H2>
      <P>{ideaWords ? "Test an idea with a waitlist before you build it." : "Start a waitlist for what you're building."}</P>
      <UL>
        <li>
          <Open href="/help/launch-and-waitlist#create">{ideaWords ? "Create an idea" : "Create a launch"}</Open>
        </li>
        <li>
          <Open href="/help/launch-and-waitlist#welcome">Turn on the welcome email</Open>
        </li>
        <li>
          <Open href="/help/launch-and-waitlist#share">Share your waitlist page</Open>
        </li>
      </UL>

      <H2 id="grow">3. Grow audience</H2>
      <P>Write content that brings people to your waitlist.</P>
      <UL>
        <li>
          <Open href="/help/programmes-and-knowledge#start">Start a content programme</Open> and{" "}
          <Open href="/help/programmes-and-knowledge#knowledge">add your website to its knowledge</Open>
        </li>
        <li>
          <Open href="/help/brand-map">Save your brand map</Open>, if you&apos;ll write blog articles
        </li>
        <li>
          <Open href="/help/connected-accounts#social">Connect LinkedIn or X</Open>, then{" "}
          <Open href="/help/write-and-schedule#schedule">schedule your first post</Open>
        </li>
        <li>
          <Open href="/help/write-and-schedule#newsletter">Send a newsletter to your waitlist</Open>
        </li>
      </UL>

      <H2 id="product">4. Launch product</H2>
      <P>Connect your app so YouGrow knows what each person does in it. Part of this is for your developer.</P>
      <UL>
        <li>
          <Open href="/help/connect-your-product#sandbox">Try a sandbox</Open> to see the whole flow first (optional)
        </li>
        <li>
          <Open href="/help/connect-your-product#connect">Connect your product</Open> and{" "}
          <Open href="/help/connect-your-product#learn">learn it from your repo</Open>
        </li>
        <li>
          <Open href="/help/connect-your-product#developer">Hand the rest to your developer</Open>, and wait for your first
          sign-up
        </li>
        <li>
          <Open href="/help/invite-your-waitlist">Invite your waitlist</Open>
        </li>
      </UL>

      <H2 id="retain">5. Onboard &amp; retain</H2>
      <P>Email each person about what they have and haven&apos;t done yet.</P>
      <UL>
        <li>
          <Open href="/help/onboarding-journeys#build">Build an onboarding journey</Open>
        </li>
        <li>
          <Open href="/help/onboarding-journeys#test">Test it on real people</Open>
        </li>
        <li>
          <Open href="/help/onboarding-journeys#live">Switch it to live</Open>
        </li>
      </UL>

      <H2 id="order">Where the order matters</H2>
      <Warning>
        <strong>Domain first.</strong> Until it&apos;s verified, your emails come from a shared default address and no journey
        can go live.
      </Warning>
      <Warning>
        <strong>Welcome email before you share your page.</strong> Then everyone gets it from the start. Publish it later and
        YouGrow asks whether the people already on the list should get it too.
      </Warning>
      <Warning>
        <strong>Journey before sign-ups flow.</strong> A journey only takes people who signed up in the last 3 days, unless you
        widen that in its Settings.
      </Warning>
      <Warning>
        <strong>Accounts before posts.</strong> YouGrow won&apos;t schedule a LinkedIn or X post until its account is connected.
      </Warning>

      <H2 id="help">Getting help</H2>
      <H3>Ask Vizzy</H3>
      <P>
        Vizzy is the assistant inside YouGrow. Ask it &quot;What should I set up first?&quot; and it reads where you are. It
        drafts things for you, and nothing goes live until you publish it.
      </P>
      <H3>Something not working?</H3>
      <P>
        Start with <Open href="/help/troubleshooting">Why isn&apos;t this working?</Open>
      </P>
      <H3>For developers</H3>
      <P>
        Connecting your app is in the <Open href="/developers">developer docs</Open>. They also work as instructions for a
        coding agent.
      </P>

      <NextPage slug="" ideaWords={ideaWords} />
    </article>
  );
}
