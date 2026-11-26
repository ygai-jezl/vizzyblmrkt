import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { ERASE_COPY, ERASE_MESSAGES, HISTORY_COPY, RESTORE_MESSAGES } from "@/components/admin/settings/historyWords";
import { BEFORE_HISTORY_TEXT, NEVER_UNDONE } from "@/lib/settings/words";

/**
 * /help/history-and-restore (SETTINGS_HISTORY_ENABLED, ADR-0021): Settings › History, where the
 * team reads every change to the brand's fields, journeys, product catalogs and shared connections,
 * an admin previews and restores an older version, and anyone exports one. The words it quotes are
 * the app's own (src/components/admin/settings/historyWords.ts).
 */
export default function HistoryAndRestoreHelp() {
  return (
    <article>
      <H1>History and restore</H1>
      <Lead>
        Every change to your fields, journeys, product catalogs and shared connections, in one list. See who changed what and when,
        put an older version back as a new one, or download any version.
      </Lead>
      <Meta items={["About 3 minutes", "Your whole team reads it; admins restore", "When a change needs undoing"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>History turned on in your copy of YouGrow</li>
            <li>An admin on your brand&apos;s team, to restore</li>
          </>
        }
        unlocks={
          <>
            <li>Undoing a change to your fields, a journey or a catalog, without losing the version you undo</li>
            <li>A copy of any version, to keep or to read</li>
          </>
        }
      />

      <H2 id="list">The list</H2>
      <P>
        Open <Open href="/admin/account/history">Settings › History</Open>. It shows the brand you are in, newest change first: what
        changed, its version, who made the change and when. Pick <strong>Fields</strong>, <strong>Journeys</strong>,{" "}
        <strong>Product catalogs</strong> or <strong>Shared connections</strong> to see one kind, and press{" "}
        <strong>{HISTORY_COPY.older}</strong> at the bottom for more.
      </P>
      <UL>
        <li>A kind is listed while its own screen is on in your copy of YouGrow. Product catalogs are always listed.</li>
        <li>Someone who has left your team shows as Former team member.</li>
        <li>An owner of your organisation who isn&apos;t on this brand&apos;s team shows as An owner of your organisation.</li>
        <li>
          An address is never shown: a change saved with one before history kept names shows as A team member.
        </li>
        <li>
          A journey&apos;s live version is marked <strong>{HISTORY_COPY.live}</strong>. When a restore has filled its draft, the live
          version says which version the draft holds and who put it back.
        </li>
        <li>
          Shared connections are marked <strong>{HISTORY_COPY.readOnly}</strong>: your organisation gives and takes them back on
          Settings › Organisation.
        </li>
      </UL>
      <P>Everyone on the team sees the same list and can export. Only admins see Preview restore.</P>
      <P>
        Vizzy reads the same history: ask it who changed your welcome journey last week, or what a field&apos;s options were in an
        older version. It never restores anything.
      </P>

      <H2 id="preview">Preview a restore</H2>
      <Steps>
        <li>
          Press <strong>Preview restore</strong> on the version you want back.
        </li>
        <li>Read what it does. Nothing changes until you press the button at the bottom.</li>
      </Steps>
      <UL>
        <li>
          <strong>Comes back</strong>: fields that return from the archive, with the values people already have.
        </li>
        <li>
          <strong>Archived</strong>: fields the older version didn&apos;t have. They are hidden and read only, and their values are kept.
        </li>
        <li>
          <strong>Changes back</strong>: names and options that go back to how they were. An option added since is archived, never
          deleted.
        </li>
        <li>
          <strong>Stays empty</strong>: a field whose values were erased since it was archived. It comes back with no values.
        </li>
        <li>
          <strong>Stays archived</strong>: a field whose values are being erased. It stays archived until the erase ends.
        </li>
        <li>
          <strong>Never undone</strong>: what no restore takes back (see <Open href="/help/history-and-restore#never-undone">below</Open>).
        </li>
      </UL>

      <H2 id="restore">Restore</H2>
      <P>
        Press <strong>Restore as version</strong> and its number. The older version is saved as a new one on top, so the version you
        replaced stays in History and you can go back to it later. Nothing is deleted.
      </P>
      <P>
        If someone saves a change while the preview is open, the restore stops and says so. Press <strong>Look again</strong> to see the
        preview as things are now.
      </P>

      <H2 id="journeys">Journeys</H2>
      <P>
        A journey&apos;s restore puts the older version in its <strong>draft</strong> only. The live version, the people in it and the
        journey&apos;s email style stay as they are, and nobody gets a different email until someone presses Publish. The version you
        then publish says it came from the version you restored: &quot;Published, from version 3.&quot;
      </P>
      <UL>
        <li>
          When the draft has edits that aren&apos;t published, the preview says so, since they will be replaced. Press{" "}
          <strong>Export the draft</strong> first to keep a copy.
        </li>
        <li>
          <strong>Fix after restoring</strong> lists what the older version needs today, such as a step that waits for something your
          product&apos;s catalog no longer has. Fix it in the draft before you publish.
        </li>
        <li>An archived journey&apos;s versions are read only, with no restore or export.</li>
      </UL>

      <H2 id="catalogs">Product catalogs</H2>
      <P>
        A catalog&apos;s restore is saved as a new version, and from then on people&apos;s stages in that product are read with it. The
        first version of an older catalog says &quot;{BEFORE_HISTORY_TEXT}&quot; Restoring a catalog needs catalog history turned on in
        your copy of YouGrow; until then you can read and export its versions. A revoked product&apos;s catalog is read only.
      </P>

      <H2 id="export">Export a version</H2>
      <P>
        <strong>Export</strong> downloads one version as a JSON file. A journey&apos;s file is a journey document you can import as a
        new draft on a product. Fields and shared connections come as a settings version, and catalogs as a catalog version. An export
        holds your settings only, never anyone&apos;s values.
      </P>
      <P>
        A journey version made before journeys changed shape can&apos;t go in a draft, so its file is the design as it was stored, to
        read. It can&apos;t be imported.
      </P>

      <H2 id="never-undone">What a restore never undoes</H2>
      <P>{NEVER_UNDONE}. People already in a journey stay on the version they started on. A restore brings back settings, never people
      or records that were deleted.</P>

      <H2 id="erase">Erase an archived field&apos;s values</H2>
      <P>
        Archiving a field keeps its values on each person and company, so it can be brought back. When you no longer want them kept,
        an owner can erase them for good. It is off unless your copy of YouGrow turns it on, which needs plans, and self-hosted copies
        keep it off.
      </P>
      <UL>
        <li>
          Who: an owner of your organisation who is also an admin on this brand&apos;s team. Being an owner of the brand you first
          signed in with isn&apos;t enough until you are on its team: whoever runs your copy of YouGrow can add you.
        </li>
        <li>
          When: 30 days or more after the field was last archived. Until then, Data model says when, such as &quot;
          {ERASE_COPY.erasableFrom("14 Dec")}&quot;. A restore that archives a field starts its 30 days again.
        </li>
        <li>A legal hold on your organisation stops it.</li>
      </UL>
      <Steps>
        <li>
          In <Open href="/admin/account/data-model">Settings › Data model</Open>, press <strong>{ERASE_COPY.action}</strong> beside the
          archived field.
        </li>
        <li>
          The first press counts the people, companies, history entries and Vizzy suggestions that hold it. The count runs in the
          background and takes hours for a big list: you can close it and come back.
        </li>
        <li>When the count is done, read what goes for good and what stays, type the field&apos;s name, and press {ERASE_COPY.action}.</li>
      </Steps>
      <P>
        The erase runs in the background, a page at a time, and the dialog shows how far it is. It removes the field&apos;s value from
        each person or company and blanks it in their history and in Vizzy&apos;s suggestions. The field stays, archived, with its name
        and options, so history still reads; bringing it back later brings it back empty, and a restore&apos;s preview says
        &quot;Stays empty&quot;. Until the erase, each person&apos;s own export still includes their value. It can&apos;t be undone.
        History shows &quot;Erased the values of&quot; and the field&apos;s name, and the audit trail keeps who erased it and how many
        values went, never the values.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>History lists the restore as the newest version, with you as who made it.</li>
        <li>After a journey restore, the journey&apos;s draft shows the older version and its live version is unchanged.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [RESTORE_MESSAGES.fields_changed, "Someone saved the fields meanwhile. Press Look again, check the preview, then restore."],
          [RESTORE_MESSAGES.draft_changed, "Someone saved the journey's draft meanwhile. Press Look again; export the draft first if you want to keep it."],
          [RESTORE_MESSAGES.catalog_changed, "Someone saved the catalog meanwhile. Press Look again, then restore."],
          [HISTORY_COPY.partial, "Part of the history couldn't be read, often just after an update. Reload the page in a few minutes."],
          [ERASE_MESSAGES.not_owner, "Ask an owner of your organisation to erase it, or to make you an owner."],
          [ERASE_MESSAGES.home_only, "Ask whoever runs your copy of YouGrow to add you to this brand's team as an admin."],
          [ERASE_MESSAGES.legal_hold, "Nothing to do here: the values are kept until the hold ends."],
          [ERASE_MESSAGES.audit_unavailable, "Nothing was erased. Try again in a few minutes."],
          [ERASE_COPY.failed, "Type the field's name and press Try again: it carries on from where it stopped."],
        ]}
      />

      <NextPage slug="history-and-restore" />
    </article>
  );
}
