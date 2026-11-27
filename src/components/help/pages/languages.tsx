import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";

/** /help/languages (CONTENT_LANGUAGE_ENABLED): the language YouGrow writes a brand's copy in. */
export default function LanguagesHelp() {
  return (
    <article>
      <H1>Languages</H1>
      <Lead>
        Choose the language YouGrow writes in for your brand. Articles, posts, emails, briefs and Vizzy&apos;s suggestions
        all follow it, from the first draft.
      </Lead>
      <Meta items={["About 1 minute", "Admins", "Before you write"]} />

      <BeforeAndUnlocks
        before={<li>A brand set up in YouGrow</li>}
        unlocks={
          <>
            <li>Everything Vizzy writes for you is in your language, with no translating afterwards</li>
            <li>Checks on articles and emails that suit your language, with no false warnings</li>
          </>
        }
      />

      <H2 id="set">Set your language</H2>
      <Steps>
        <li>
          Open <Open href="/admin/account/settings">Settings</Open> and find <strong>Languages</strong>.
        </li>
        <li>
          Pick your <strong>Default language</strong>.
        </li>
        <li>
          Press <strong>Save</strong>. What you write next follows it. What you already wrote stays as it is.
        </li>
      </Steps>

      <H2 id="what">What follows it</H2>
      <UL>
        <li>Articles, newsletters and eBooks, with their research questions, fact checks and refreshes</li>
        <li>Social posts, and the words on a chart or an image&apos;s alt text</li>
        <li>Email sequences, onboarding journey emails and the personal line in each one</li>
        <li>Your brand map&apos;s questions and groups, your brand strategy and your content plan</li>
        <li>Suggest an angle, Next up and Home&apos;s next action</li>
      </UL>
      <P>
        Names of brands, products and people stay as they are. A short quote from a source can stay in its own language.
        Anything given its own language in its Strategy settings keeps that one.
      </P>

      <H2 id="labels">An article&apos;s box and section names</H2>
      <P>
        In French, Spanish, German, Japanese and Arabic, the fixed names in an article, such as Key facts, Frequently asked
        questions, Sources and the Last updated line, are written in that language. In other languages they stay in English,
        so YouGrow can still find each part of the article.
      </P>

      <H2 id="checks">Checks in other languages</H2>
      <P>
        A few checks read English words: the reading level of an email, whether an article speaks from your team&apos;s
        experience or says where it is not the right fit, and whether it says plainly what the subject is. For other
        languages these are left out, so they never ask for a rewrite that can&apos;t help. Personal lines in German are not
        checked for capitalised names, because German writes every noun with a capital.
      </P>

      <H2 id="also-offer">Also offer in</H2>
      <P>
        These are the languages your waitlist pages are offered in. A visitor sees the page in their browser&apos;s language
        when it is one of these, and can switch.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>A post you write now comes back in your language.</li>
        <li>A new article&apos;s Key facts box and Last updated line are in your language, or in English for a language without its own names.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Couldn't load your language settings.", "Refresh the page. If it keeps happening, ask whoever runs your YouGrow to check the app's logs."],
        ]}
      />

      <NextPage slug="languages" />
    </article>
  );
}
