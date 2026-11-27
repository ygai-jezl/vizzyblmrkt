import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { isLanguageReadersEnabled } from "@/lib/i18n/flags";
import type { HelpBodyProps } from "@/lib/help/pages";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { isRaiseKitEnabled } from "@/lib/raise/docs/flags";
import { ideaWord } from "@/lib/nav/terms";

/**
 * /help/languages (CONTENT_LANGUAGE_ENABLED): the language YouGrow writes a brand's copy in. With
 * `languageReaders` (LANGUAGE_READERS_ENABLED) it also covers readers per language, the threshold
 * and the one list launches use. With ideas in the words (`ideaWords`) a launch is called an idea.
 * With the Raise kit on (`raiseKit`) it says decks stay in English for now.
 */
export default function LanguagesHelp({
  languageReaders = isLanguageReadersEnabled(),
  ideaWords = isIdeaWordsEnabled(),
  raiseKit = isRaiseKitEnabled(),
}: HelpBodyProps = {}) {
  const w = ideaWord(ideaWords);
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
            <li>
              {raiseKit ? "Everything Vizzy writes for you, except Raise kit decks and lender packs for now," : "Everything Vizzy writes for you"} is in your
              language, with no translating afterwards
            </li>
            <li>Checks on articles and emails that suit your language, with no false warnings</li>
            {languageReaders ? <li>How many of your people read each language, so you know which ones need their own version</li> : null}
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
      {raiseKit ? (
        <P>
          Decks and lender packs from the <Open href="/help/raise-kit">Raise kit</Open> are in English for now, whatever your
          language.
        </P>
      ) : null}

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

      {languageReaders ? (
        <>
          <H2 id="readers">Readers</H2>
          <P>
            Under your languages, each one shows its readers: the people in your audience whose language we know, from the
            language they signed up in or the one your product sends for them. Anyone we don&apos;t know counts as your
            default language. The numbers are counted again each day, and when you change the list.
          </P>

          <H2 id="threshold">The 10 reader rule</H2>
          <P>
            A language other than your default gets its own version once it has at least 10 readers. Until then its readers
            get your default language, so nothing is made that hardly anyone reads. The table says which languages are
            ready and how many more readers the others need.
          </P>
          <P>
            An admin can change the number in <strong>Make a version once a language has at least</strong>, then press{" "}
            <strong>Save</strong>.
          </P>

          <H2 id="one-list">One list for your {w.many}</H2>
          <P>
            Your {w.many} offer your brand&apos;s languages, so you keep one list. {w.A}&apos;s Strategy settings show
            the list, with a link to change it here. {w.A} can still pick its own content language.
          </P>
          <P>
            {w.A} that had languages of its own keeps offering them. Its settings show them under{" "}
            <strong>Only on this {w.one}</strong>: press <strong>Move to your brand list</strong>, then save the {w.one}.
          </P>
        </>
      ) : null}

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>A post you write now comes back in your language.</li>
        <li>A new article&apos;s Key facts box and Last updated line are in your language, or in English for a language without its own names.</li>
        {languageReaders ? <li>Each language under Languages shows its readers and whether it gets its own version.</li> : null}
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Couldn't load your language settings.", "Refresh the page. If it keeps happening, ask whoever runs your YouGrow to check the app's logs."],
          ...(languageReaders
            ? ([
                ["Couldn't save your language settings.", "Check the number is between 1 and 1,000, then press Save again."],
                ["Only an admin can change this number.", "Ask an admin of your brand to change it."],
                ["Couldn't add them to your brand list. Try again.", "Press Move to your brand list again. If it keeps happening, add them in Settings."],
              ] as Array<[string, string]>)
            : []),
        ]}
      />

      <NextPage slug="languages" />
    </article>
  );
}
