"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { personHref } from "@/lib/audience/paths";
import {
  CONSENT_WAYS,
  NEW_PERSON_MESSAGES,
  NEW_PERSON_NOTES,
  newPersonErrorText,
  peopleWarning,
  type ConsentWay,
  type NewPersonInfo,
  type NewPersonVia,
} from "@/lib/audience/newPerson";
import type { FieldValue, RecordField } from "@/lib/types/recordField";
import { api } from "../connect/api";
import { Banner, Button, inputClass } from "../connect/ui";
import { Modal } from "../email/Modal";
import { FieldInput } from "./FieldsPanel";
import { loadFieldLists, type Team } from "./fieldsApi";

/**
 * New person (AUDIENCE_ADD_PERSON_ENABLED): an admin adds someone by hand, from the People list or
 * ⌘K. An email or a phone, a name, two of the brand's fields (more on request) and how they agreed
 * to marketing email. A known address or phone opens that person instead. Near or over the plan's
 * people it says so and still adds them.
 *
 * With `draftId` (AUDIENCE_VIZZY_ADD_PERSON_ENABLED) it opens filled in from what Vizzy saved: the
 * details and field values, never how they agreed, which the admin says. Adding them closes the
 * draft; Dismiss clears it.
 */

/** Fields shown before "More of your fields". */
const FIRST_FIELDS = 2;

const label = "text-xs font-medium text-neutral-600 dark:text-neutral-400";
const hint = "block text-xs text-neutral-500";

export function NewPersonDialog({
  via,
  fields: fieldsOn,
  prefill = {},
  draftId = null,
  onClose,
}: {
  via: NewPersonVia;
  /** Fields are on (AUDIENCE_FIELDS_ENABLED): the form offers the brand's own fields. */
  fields: boolean;
  /** Field values to start with, such as the value the list is filtered by. */
  prefill?: Record<string, FieldValue>;
  /** The New person form Vizzy filled in, by its id: the form opens with what it holds. */
  draftId?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [how, setHow] = useState<ConsentWay>("in_person");
  const [note, setNote] = useState("");
  const [info, setInfo] = useState<NewPersonInfo | null>(null);
  const [fieldList, setFieldList] = useState<RecordField[]>([]);
  const [team, setTeam] = useState<Team>([]);
  const [values, setValues] = useState<Record<string, unknown>>(prefill);
  const [allFields, setAllFields] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedWithout, setAddedWithout] = useState<string | null>(null);
  /** Vizzy's draft: loading, open (with the values it filled in), or gone. */
  const [draft, setDraft] = useState<"none" | "loading" | "open" | "gone">(draftId ? "loading" : "none");
  const [start, setStart] = useState<Record<string, FieldValue>>(prefill);

  useEffect(() => {
    if (!draftId) return;
    void api<{ draft: { email: string | null; phone: string | null; firstName: string | null; lastName: string | null; fields: Record<string, FieldValue> } }>(
      `/api/admin/audience/everyone/drafts/${encodeURIComponent(draftId)}`,
    ).then((r) => {
      if (!r.ok) return setDraft("gone");
      const d = r.data.draft;
      setEmail(d.email ?? "");
      setPhone(d.phone ?? "");
      setFirstName(d.firstName ?? "");
      setLastName(d.lastName ?? "");
      setStart((cur) => ({ ...cur, ...d.fields }));
      setValues((cur) => ({ ...cur, ...d.fields }));
      if (Object.keys(d.fields).length) setAllFields(true);
      setDraft("open");
    });
  }, [draftId]);

  async function dismissDraft() {
    if (!draftId) return;
    setBusy(true);
    await api(`/api/admin/audience/everyone/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
    setBusy(false);
    onClose();
  }

  useEffect(() => {
    void api<NewPersonInfo>("/api/admin/audience/everyone").then((r) => r.ok && setInfo(r.data));
    if (!fieldsOn) return;
    void loadFieldLists().then((r) => {
      if (!r.ok) return;
      setFieldList(r.data.lists.person.items.filter((f) => !f.archivedAt));
      setTeam(r.data.team);
    });
  }, [fieldsOn]);

  // The company a work address matches, once the address is typed.
  async function lookUpCompany() {
    const typed = email.trim();
    if (!typed.includes("@")) return setInfo((cur) => (cur ? { ...cur, company: null } : cur));
    const r = await api<NewPersonInfo>(`/api/admin/audience/everyone?email=${encodeURIComponent(typed)}`);
    if (r.ok) setInfo(r.data);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() && !phone.trim()) return setError(NEW_PERSON_MESSAGES.email_or_phone);
    if (agreed && how === "other" && !note.trim()) return setError(NEW_PERSON_MESSAGES.note_needed);
    setBusy(true);
    setError(null);
    const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
    const r = await api<{ personId: string; existing?: boolean; fields?: string; error?: string }>("/api/admin/audience/everyone", {
      method: "POST",
      body: JSON.stringify({
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        agreed: agreed ? { how, ...(note.trim() ? { note: note.trim() } : {}) } : null,
        ...(fieldsOn && Object.keys(set).length ? { fields: set } : {}),
        // A draft that's gone leaves a form typed by hand: it is sent as one.
        via: via === "vizzy" && draft !== "open" ? "form" : via,
        ...(draftId && draft === "open" ? { draftId } : {}),
      }),
    });
    setBusy(false);
    if (!r.ok) return setError(newPersonErrorText(r.data));
    if (r.data.fields === "not_saved") return setAddedWithout(r.data.personId);
    onClose();
    router.push(personHref(r.data.personId));
  }

  const shownFields = allFields ? fieldList : fieldList.slice(0, FIRST_FIELDS);
  const warning = peopleWarning(info?.allowance ?? null);

  return (
    <Modal open onClose={onClose} title="New person">
      {addedWithout ? (
        <div className="space-y-3">
          <Banner tone="err">{NEW_PERSON_MESSAGES.fields_not_saved}</Banner>
          <Link href={personHref(addedWithout)} onClick={onClose} className="text-sm underline underline-offset-2">
            Open their page
          </Link>
        </div>
      ) : draft === "loading" ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4 text-sm" aria-label="New person" noValidate>
          {draft === "open" ? <Banner tone="info">{NEW_PERSON_NOTES.fromVizzy}</Banner> : null}
          {draft === "gone" ? <Banner tone="err">{NEW_PERSON_MESSAGES.draft_gone}</Banner> : null}
          <div className="space-y-1">
            <label className={label} htmlFor="np-email">
              Email
            </label>
            <input id="np-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => void lookUpCompany()} className={inputClass} />
            <span className={hint}>{NEW_PERSON_NOTES.emailHint}</span>
          </div>
          <div className="space-y-1">
            <label className={label} htmlFor="np-phone">
              Phone
            </label>
            <input id="np-phone" type="tel" autoComplete="off" placeholder="Optional" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} />
            <span className={hint}>{NEW_PERSON_NOTES.phoneOnly}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className={label} htmlFor="np-first">
                First name
              </label>
              <input id="np-first" type="text" autoComplete="off" maxLength={100} value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputClass} />
            </div>
            <div className="space-y-1">
              <label className={label} htmlFor="np-last">
                Last name
              </label>
              <input id="np-last" type="text" autoComplete="off" maxLength={100} value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputClass} />
            </div>
          </div>
          {info?.company ? (
            <div className="space-y-0.5">
              <span className={label}>Company</span>
              <span className="block">
                {info.company.name ?? info.company.domain} <span className="text-xs text-neutral-500">· matched from the email address</span>
              </span>
            </div>
          ) : null}

          {shownFields.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {shownFields.map((f) => (
                <div key={f.key} className="space-y-1">
                  {f.type === "checkbox" ? null : <span className={label}>{f.label}</span>}
                  <FieldInput field={f} value={start[f.key]} team={team} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
                </div>
              ))}
            </div>
          ) : null}
          {fieldList.length > FIRST_FIELDS && !allFields ? (
            <button type="button" className="text-xs underline underline-offset-2" onClick={() => setAllFields(true)}>
              + More of your fields
            </button>
          ) : null}

          <fieldset className="space-y-1">
            <legend className={label}>Marketing emails</legend>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-1.5">
                <input type="radio" name="np-consent" checked={!agreed} onChange={() => setAgreed(false)} /> Not yet
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="np-consent" checked={agreed} onChange={() => setAgreed(true)} /> They agreed
              </label>
            </div>
          </fieldset>
          {agreed ? (
            <fieldset className="space-y-2">
              <legend className={label}>How did they agree?</legend>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {CONSENT_WAYS.map((w) => (
                  <label key={w.how} className="flex items-center gap-1.5">
                    <input type="radio" name="np-how" checked={how === w.how} onChange={() => setHow(w.how)} /> {w.label}
                  </label>
                ))}
              </div>
              {how === "other" ? (
                <input
                  type="text"
                  aria-label="How they agreed"
                  placeholder="A short note"
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className={inputClass}
                />
              ) : null}
              <span className={hint}>{NEW_PERSON_NOTES.agreeHint}</span>
            </fieldset>
          ) : null}

          <div className="space-y-1 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
            <span className="block">{NEW_PERSON_NOTES.nothingSent}</span>
            {warning ? <span className="block text-amber-700 dark:text-amber-400">{warning}</span> : null}
          </div>

          {error ? <Banner tone="err">{error}</Banner> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button tone="primary" type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add person"}
            </Button>
            <Button onClick={onClose}>Cancel</Button>
            {draft === "open" ? (
              <Button tone="danger" disabled={busy} onClick={() => void dismissDraft()} className="ml-auto">
                Dismiss Vizzy&rsquo;s draft
              </Button>
            ) : null}
          </div>
          <span className={hint}>{NEW_PERSON_NOTES.existing}</span>
        </form>
      )}
    </Modal>
  );
}
