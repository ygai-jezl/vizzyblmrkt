"use client";

import { useState } from "react";
import { getRecaptchaToken } from "@/lib/security/recaptchaClient";

interface Question {
  question_value: string;
  optional: boolean;
  answer_value: string[] | null;
}

interface Props {
  campaignId: string;
  requiredContactDetail: "EMAIL" | "PHONE" | "BOTH" | "EITHER";
  usesFirstnameLastname: boolean;
  questions: Question[];
  referredBySignupToken?: string;
  buttonColor: string;
  successMessage: string;
}

interface SuccessState {
  alreadyJoined: boolean;
  referralLink: string;
  totalSignups: number;
  needsVerification: boolean;
}

export function SignupForm({
  campaignId,
  requiredContactDetail,
  usesFirstnameLastname,
  questions,
  referredBySignupToken,
  buttonColor,
  successMessage,
}: Props) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "submitting" | "error" | "success">("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [copied, setCopied] = useState(false);

  const showEmail = requiredContactDetail !== "PHONE";
  const showPhone = requiredContactDetail === "PHONE" || requiredContactDetail === "BOTH" || requiredContactDetail === "EITHER";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);

    const body: Record<string, unknown> = {};
    if (usesFirstnameLastname) {
      body.firstName = firstName.trim();
      body.lastName = lastName.trim();
    }
    if (showEmail && email.trim()) body.email = email.trim();
    if (showPhone && phone.trim()) body.phone = phone.trim();
    if (referredBySignupToken) body.referredBySignupToken = referredBySignupToken;
    const answerList = questions
      .filter((q) => (answers[q.question_value] ?? "").length > 0)
      .map((q) => ({ question_value: q.question_value, answer_value: answers[q.question_value]! }));
    if (answerList.length) body.answers = answerList;

    try {
      const recaptchaToken = await getRecaptchaToken("signup");
      if (recaptchaToken) body.recaptchaToken = recaptchaToken;

      const res = await fetch(`/api/waitlist/${campaignId}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const issues = Array.isArray(data.issues)
          ? data.issues.map((i: unknown) => (typeof i === "string" ? i : (i as { message?: string }).message)).join(", ")
          : null;
        setError(issues || data.error || "Something went wrong.");
        setStatus("error");
        return;
      }
      setSuccess({
        alreadyJoined: !!data.alreadyJoined,
        referralLink: data.referralLink,
        totalSignups: data.totalSignups,
        needsVerification: !!data.needsVerification,
      });
      setStatus("success");
    } catch {
      setError("Network error — please try again.");
      setStatus("error");
    }
  }

  if (status === "success" && success?.needsVerification) {
    return (
      <section className="space-y-3 rounded-xl border border-neutral-200 p-6 text-center dark:border-neutral-800">
        <h2 className="text-xl font-semibold">Almost there — check your email 📧</h2>
        <p className="text-sm text-neutral-500">
          We sent a confirmation link to lock in your spot. Your place on the
          waitlist is not counted until you confirm.
        </p>
      </section>
    );
  }

  if (status === "success" && success) {
    return (
      <section className="space-y-4 rounded-xl border border-neutral-200 p-6 text-center dark:border-neutral-800">
        <h2 className="text-xl font-semibold">
          {success.alreadyJoined ? "You're already on the list 🎉" : successMessage}
        </h2>
        <p className="text-sm text-neutral-500">
          {success.totalSignups.toLocaleString()} people have joined. Share your
          link to move up the queue.
        </p>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={success.referralLink}
            className="flex-1 truncate rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            className="rounded-md px-4 py-2 text-sm font-medium text-white"
            style={{ backgroundColor: buttonColor }}
            onClick={async () => {
              await navigator.clipboard.writeText(success.referralLink);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {usesFirstnameLastname ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" value={firstName} onChange={setFirstName} required />
          <Field label="Last name" value={lastName} onChange={setLastName} required />
        </div>
      ) : null}

      {showEmail ? (
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          required={requiredContactDetail !== "EITHER"}
          placeholder="you@example.com"
        />
      ) : null}

      {showPhone ? (
        <Field
          label="Phone"
          type="tel"
          value={phone}
          onChange={setPhone}
          required={requiredContactDetail === "PHONE" || requiredContactDetail === "BOTH"}
        />
      ) : null}

      {questions.map((q) => (
        <div key={q.question_value} className="space-y-1">
          <label className="block text-sm font-medium">
            {q.question_value}
            {q.optional ? <span className="text-neutral-400"> (optional)</span> : null}
          </label>
          {q.answer_value ? (
            <select
              required={!q.optional}
              value={answers[q.question_value] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.question_value]: e.target.value }))}
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="">Select…</option>
              {q.answer_value.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : (
            <input
              required={!q.optional}
              value={answers[q.question_value] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.question_value]: e.target.value }))}
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          )}
        </div>
      ))}

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="w-full rounded-md px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        style={{ backgroundColor: buttonColor }}
      >
        {status === "submitting" ? "Joining…" : "Join the waitlist"}
      </button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
    </div>
  );
}
