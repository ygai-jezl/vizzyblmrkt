import { H1, H2, Lead, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { isConnectorsSearchTextEnabled } from "@/lib/connectors/flags";
import { SEARCH_TEXT_HELP } from "@/lib/connectors/helpText";
import type { HelpBodyProps } from "@/lib/help/pages";
import { isRaiseKitEnabled } from "@/lib/raise/docs/flags";
import { isSearchFamilyIndexEnabled } from "@/lib/search/flags";

/**
 * /help/search. `connectorsSearchText` is whether Search Console's searches are in brand search
 * (CONNECTORS_SEARCH_TEXT_ENABLED, ADR-0013), and `searchFamily` whether the brand map family is
 * kept there with its first questions (SEARCH_FAMILY_INDEX_ENABLED, ADR-0025), and `raiseKit`
 * whether the Raise kit's decks are (RAISE_KIT_ENABLED); the How to drawer passes what the server said.
 */
export default function SearchHelp({
  connectorsSearchText = isConnectorsSearchTextEnabled(),
  searchFamily = isSearchFamilyIndexEnabled(),
  raiseKit = isRaiseKitEnabled(),
}: HelpBodyProps = {}) {
  return (
    <article>
      <H1>Search</H1>
      <Lead>
        Find anything your brand wrote by its words or by what it means: articles, emails, posts, your brand map, your
        knowledge and more. Vizzy searches the same place.
      </Lead>
      <Meta items={["About 2 minutes", "Everyone on the team", "Any time"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Search turned on for your brand</li>
            <li>
              Something written: an article, a journey, your <Open href="/help/brand-map">brand map</Open> or a{" "}
              <Open href="/help/programmes-and-knowledge">knowledge source</Open>
            </li>
          </>
        }
        unlocks={
          <>
            <li>One place to find what you already said, before you write it again</li>
            <li>Vizzy answers from your own words and names where it found them</li>
          </>
        }
      />

      <H2 id="find">Find something</H2>
      <Steps>
        <li>
          Press <strong>Ctrl K</strong> (<strong>⌘K</strong> on a Mac) anywhere in YouGrow.
        </li>
        <li>
          Type what you are looking for. A product code like FL-204, a name, or a question in your own words all work.
        </li>
        <li>
          Results show under <strong>Found in what you wrote</strong>. Pick a group such as <strong>Emails</strong> to see only
          those.
        </li>
        <li>Press Enter or click a result to open it.</li>
      </Steps>

      <H2 id="why">Why a result matched</H2>
      <P>Each result has a badge that says how it was found:</P>
      <Pairs
        head={["Badge", "What it means"]}
        rows={[
          ["Words", "It contains the words you typed, or forms of them (repot finds repotting)."],
          ["Meaning", "It is about the same thing in other words (bigger pot finds an article on repotting)."],
          ["Both", "It matched both ways, so it is usually the best result."],
        ]}
      />
      <P>
        The two lists are merged into one order. For US brands Google can then reorder the top results, when that is turned on.
      </P>

      <H2 id="whats-in">What search covers</H2>
      <UL>
        <li>Articles, newsletters and ebooks, social posts, Scrapbook clippings and templates</li>
        <li>Journey emails, email steps and broadcasts</li>
        <li>Your brand voice, brand kit and author bios</li>
        <li>Your brand map: subjects, questions, buying situations, research you imported, and What we&apos;ve seen notes</li>
        <li>Knowledge sources, your product map, competitors and what their articles cover, and image prompts</li>
        {raiseKit ? (
          <li>
            Decks and lender packs from the <Open href="/help/raise-kit">Raise kit</Open>, slide by slide: each slide&apos;s words
            and its speaker notes
          </li>
        ) : null}
        {connectorsSearchText ? (
          <li>
            Google searches from your <Open href="/help/connected-data#search-text">Search Console connection</Open>: the
            top searches of the last 28 days, with their clicks, impressions and position
          </li>
        ) : null}
      </UL>
      <P>
        It leaves out people&apos;s own words: sign-up answers, voice conversations, social comments and person plans. It
        also leaves out notes marked as naming a customer, and competitors&apos; quotes and authors.
      </P>
      {connectorsSearchText ? (
        <P>
          {SEARCH_TEXT_HELP.why} {SEARCH_TEXT_HELP.who} {SEARCH_TEXT_HELP.vizzy} {SEARCH_TEXT_HELP.when}
        </P>
      ) : null}
      {searchFamily ? (
        <P>
          A subject on your brand map is also found by its first questions. Proposed subjects and buying situations
          don&apos;t show here until you add them to your map.
        </P>
      ) : null}
      <P>
        {searchFamily
          ? "New and changed things are found within about 10 minutes. Subjects, buying situations and What we've seen notes are found as soon as you save them, and a competitor's article as soon as it is read. The questions on your brand map and what a competitor's site is about can take up to 6 hours."
          : "New and changed things are found within about 10 minutes."}{" "}
        An article you save is usually found straight away. Each brand&apos;s search is kept apart from every other
        brand&apos;s, in the same region as the rest of your data.
      </P>

      <H2 id="settings">The Search card in Settings</H2>
      <P>
        <Open href="/admin/account/settings">Settings</Open> has a <strong>Search</strong> card:
      </P>
      <Pairs
        head={["Line", "What it shows"]}
        rows={[
          ["Region", "Where your search index is kept. It is always your brand's own region."],
          ["Model", "The model that reads the meaning of your text."],
          ["Reranking", "Whether Google reorders the top results. Only for US brands, so EU and Asia text stays in its region."],
          ["Last update", "When something was last added or changed."],
          ["Counts", "How many things of each kind can be found."],
        ]}
      />
      <P>
        Admins can press <strong>Rebuild index</strong> to bring it up to date now instead of waiting for the next check.
      </P>

      <H2 id="vizzy">Ask Vizzy</H2>
      <P>
        Ask Vizzy something like &quot;What have we already said about returns?&quot;. It searches your brand, answers from
        what it finds and names each source, so you can open it. It never changes anything when it searches.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>Ctrl K shows Found in what you wrote after you type two letters or more.</li>
        <li>The Search card in Settings counts what you have written.</li>
        <li>A word from an article you just saved finds it.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Search isn't available for this brand yet.", "Search is turned on brand by brand. Ask whoever runs your YouGrow to turn it on for yours."],
          ["Nothing in the index yet. The first check fills it within about 10 minutes.", "Wait a few minutes, or ask an admin to press Rebuild index."],
          ["Nothing you wrote matches yet.", "Try fewer words, or a phrase you would expect in the text."],
          ["Search didn't answer. Try again in a moment.", "Try again. If it keeps happening, ask whoever runs your YouGrow to check the search databases."],
          ["Part done. The next check carries on with the rest.", "There was a lot to add. The scheduled check finishes it within a few minutes."],
          ["Only admins can rebuild the search index.", "Ask an admin on your team."],
        ]}
      />

      <NextPage slug="search" />
    </article>
  );
}
