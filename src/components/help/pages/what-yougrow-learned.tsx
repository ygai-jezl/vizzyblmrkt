import { H1, H2, Lead, Note, P, Pairs, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Messages, Meta, NextPage, Open } from "@/components/help/blocks";
import { CHECK_EXAMPLES, COULDNT_LEARN, NOT_LEARNING_WHILE_OPEN, NOT_SET_UP, SUGGESTIONS_PAUSED, WHY_WORDS } from "@/lib/loops/learnedWords";
import { LOOK_REFUSED_MESSAGE, NOTE_REFUSED_MESSAGE } from "@/lib/loops/textCheck";
import { VOTE_REASONS } from "@/lib/loops/reasons";

/**
 * /help/what-yougrow-learned (IMAGE_STYLE_VERSIONS_ENABLED, learning loops step 4, screen 4): what
 * each painted image style learned from votes, how a new look is checked, the why behind a vote,
 * Undo, Pause, Forget, Edit and Keep, the 1 in 20 images made without what was learned, where it
 * is kept, and Vizzy. Made up businesses only. The check examples are verdict()'s own words
 * (learnedWords.test.ts), and the messages are the card's (help.test.ts checks each is in the app).
 */
export default function WhatYouGrowLearnedHelp() {
  const labels = (direction: "down" | "up") => VOTE_REASONS.image[direction].map((r) => r.label);
  const down = labels("down");
  const up = labels("up");
  const or = (list: string[]) => `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
  return (
    <article>
      <H1>What YouGrow learned</H1>
      <Lead>
        YouGrow learns the look of your images from your votes, keeps every version, and checks whether each new look does
        better. You can undo, pause or forget any of it.
      </Lead>
      <Meta items={["About 5 minutes to read", "Anyone on your team", "Admins change it"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Some images made in a painted style, such as Natural photo or Illustration</li>
            <li>A few minutes to vote on them</li>
          </>
        }
        unlocks={
          <>
            <li>New images that follow the look you like</li>
            <li>A check on each new look, so a worse one can go back</li>
          </>
        }
      />

      <H2 id="image-looks">A look for each style</H2>
      <P>
        Each painted style learns its own look: a few words that go into every image made in that style. Open{" "}
        <Open href="/admin/brand-kit/image-style">Brand › Image style</Open> and scroll to <strong>What it learned</strong> to
        see each look, where it came from and how its images did.
      </P>
      <P>
        A style with no look of its own uses your brand&apos;s look, which learns from every image you like and every photo you
        upload. Drawn styles, such as Headline card and Data story, keep their layout and don&apos;t learn.
      </P>
      <P>
        Hearth Bakery liked three overhead shots of loaves on dark wood and didn&apos;t like two studio shots. Its Natural photo
        look became &quot;Overhead daylight, flour dusted on dark wood, loaves close up, warm and soft, no people.&quot;
      </P>

      <H2 id="votes">How your votes teach it</H2>
      <UL>
        <li>
          Vote with <strong>On-brand</strong> or <strong>Off-brand</strong> under an image in Create, or in its details in
          Content › Library. On-brand counts as a like.
        </li>
        <li>A style learns its first look after 3 likes. The images you didn&apos;t like go in as what to avoid.</li>
        <li>
          After that, a look stays until the next change can be checked against it: about 20 images made with it and 10 of its
          votes counted. A look you liked at most once in its first 6 votes can change sooner.
        </li>
        <li>A new look comes at most once a week, after 3 new likes.</li>
        <li>A vote counts toward a check only if it comes within 2 weeks of the image being made.</li>
      </UL>
      <P>
        You can also say why. After <strong>Off-brand</strong>, <strong>{WHY_WORDS.down.title}</strong> opens under the thumbs:{" "}
        {or(down)}. After <strong>On-brand</strong>, press <strong>{WHY_WORDS.up.link}</strong> to pick {or(up)}. A reason can
        take a note of up to 200 characters.
      </P>
      <UL>
        <li>Reasons and notes are optional. The vote counts the moment you press it.</li>
        <li>
          The next look reads them: what you didn&apos;t like goes in as what to avoid, grouped by reason. Reasons change what
          the next look says, not when it comes.
        </li>
        <li>
          Anyone on your team can give a reason. Your team sees a note on the image&apos;s details, without who wrote it. Notes
          stay with your brand&apos;s data and are never counted.
        </li>
        <li>Changing your vote clears its reason and note.</li>
        <li>
          If most of your recent Off-brand votes had no reason, {WHY_WORDS.down.title} starts closed, as{" "}
          <strong>{WHY_WORDS.down.link}</strong>.
        </li>
      </UL>

      <H2 id="checks">How YouGrow checks a new look</H2>
      <P>
        YouGrow compares how often you liked images made with the new look against the look before. It first checks once both
        looks have 10 votes, then again at 20, 40, 80 and 120, and says one of these. These examples come from the same sums the
        app uses.
      </P>
      <Pairs head={["What it says", "What it means"]} rows={CHECK_EXAMPLES.map((e) => [`"${e.says}"`, e.means])} />
      <Note tone="warn">
        Checks are not adjusted for season. A look learned in December may read worse in January for reasons that have nothing
        to do with the look.
      </Note>
      <P>
        With a few votes a month, as at Hearth Bakery, a check can take months. Until then what it learned is used, and you can
        undo it. Lumen votes on many more images, so its looks are checked within weeks.
      </P>

      <H2 id="undo-pause-forget">Undo, Pause and Forget</H2>
      <UL>
        <li>
          <strong>Undo</strong> puts the look before back, and YouGrow won&apos;t learn the same look again from the likes that
          made it.
        </li>
        <li>
          <strong>Pause image learning</strong>, in the More menu at the top of What it learned, keeps every look in use and
          learns nothing new until you resume.
        </li>
        <li>
          <strong>Forget</strong> stops using a look, clears its words and never learns again from the images that taught it.
          Your votes stay. It can&apos;t be undone.
        </li>
        <li>Only admins can undo, pause, edit or forget. Everyone&apos;s votes teach it.</li>
      </UL>
      <P>
        <strong>Reset</strong> on the Image style card puts your style choices back to the presets. It leaves what YouGrow
        learned alone: use Forget for that.
      </P>

      <H2 id="set-by-you">Set by you, and Keep</H2>
      <UL>
        <li>
          <strong>Edit the words</strong> writes your own look. YouGrow always uses it, keeps counting your votes and never
          changes it. Undo goes back to the learned look.
        </li>
        <li>
          When Review asks to go back to an earlier look, <strong>Keep this look</strong> keeps the newer one. YouGrow only asks
          again if a later check reads worse.
        </li>
        <li>
          <strong>Go back</strong> puts the earlier look back, with Undo next to it. Undo brings the newer look back and answers
          the card, so it doesn&apos;t come back.
        </li>
      </UL>

      <H2 id="holdback">About 1 image in 20</H2>
      <P>
        About 1 image in 20 is made without what YouGrow learned, so it can check that learning helps. Only the learned look and
        the reference images picked from your votes are left out; your logo, icons and graphics stay. You see which one it was
        after you vote, or when you open How this was made in an image&apos;s details, so it doesn&apos;t sway your vote.
      </P>
      <P>
        Looks you set or keep are always used. To always use what it learned, turn off{" "}
        <strong>Help check that learning works</strong> in <Open href="/admin/account/settings">Settings › General</Open>.
      </P>

      <H2 id="where-it-is-kept">Where it is kept</H2>
      <UL>
        <li>Looks, their versions and their counts are kept with your brand&apos;s data, in its region: the United States, Europe or Asia.</li>
        <li>
          Looks learned before YouGrow kept versions also stay on your brand&apos;s record in the United States until they are
          cleared. Forget or Reset clears them sooner.
        </li>
        <li>Images are kept in one store for every brand, not by region.</li>
        <li>The model that makes images and learns looks isn&apos;t tied to a region.</li>
        <li>Vizzy&apos;s chats are kept where Vizzy runs.</li>
      </UL>

      <H2 id="vizzy">Ask Vizzy</H2>
      <P>
        Vizzy can read what was learned: each look&apos;s words, who set it, where it came from, how its images did and what
        the last check said. Ask &quot;What has YouGrow learned about our photos?&quot; Vizzy never changes a look itself.
      </P>

      <H2 id="messages">Messages</H2>
      <Messages
        rows={[
          [NOT_SET_UP, "This copy has no image model set up. Whoever runs it adds one; until then nothing is learned."],
          [COULDNT_LEARN, "Nothing. YouGrow tries again each day, and the looks in use stay."],
          [SUGGESTIONS_PAUSED, "Press Resume suggestions to see them in Review again. Until then a worse check shows on What it learned, with Go back."],
          [NOT_LEARNING_WHILE_OPEN, "A Go back card waits in Review. Press Go back or Keep this look, and learning carries on."],
          [LOOK_REFUSED_MESSAGE, "Your words have a link, an email address, a handle or a phone number. Take it out and save again."],
          [NOTE_REFUSED_MESSAGE, "Your note has one. Take it out and press Done again; the reason is already saved."],
          ["Thanks. The next Natural photo look takes this into account.", "Nothing. Your reason and note are saved, and the next look for that style reads them."],
          [WHY_WORDS.down.link, "Most of your recent Off-brand votes had no reason, so the row starts closed. Press it to give one."],
        ]}
      />

      <NextPage slug="what-yougrow-learned" />
    </article>
  );
}
