import { describe, it, expect } from "vitest";
import {
  formatMessage,
  getMessage,
  getMessages,
  getWidgetMessages,
  translate,
  pluralCategory,
  pluralText,
} from "./messages";

describe("formatMessage", () => {
  it("interpolates single-brace {placeholders}", () => {
    expect(formatMessage("{name}: hello", { name: "Acme" })).toBe("Acme: hello");
    expect(formatMessage("rank {n}", { n: 3 })).toBe("rank 3");
  });
  it("leaves {{merge_tokens}} untouched (must survive into the send pipeline)", () => {
    const out = formatMessage("Hi {{first_name}}, you are {n}", { n: 1, first_name: "X" });
    expect(out).toBe("Hi {{first_name}}, you are 1");
    expect(out).toContain("{{first_name}}");
  });
  it("leaves unknown single-brace placeholders as-is", () => {
    expect(formatMessage("{name} {missing}", { name: "A" })).toBe("A {missing}");
  });
});

describe("getMessage", () => {
  it("resolves an English base key with interpolation", () => {
    expect(getMessage("en", "email.fallback.subject.quickUpdate", { name: "Beta" })).toBe(
      "A quick update from Beta",
    );
  });
  it("preserves merge tokens in catalog copy", () => {
    const line = getMessage("en", "email.fallback.body.rankLine", { name: "Beta" });
    expect(line).toContain("{{current_rank}}");
    expect(line).toContain("{{referral_link}}");
    expect(line).toContain("Beta"); // the single-brace {name} was interpolated
  });
  it("falls back to English for a locale with no catalog file yet", () => {
    // "pt" has no catalog shipped ⇒ English base is returned (documented gap).
    expect(getMessage("pt", "email.fallback.subject.default")).toBe(
      getMessage("en", "email.fallback.subject.default"),
    );
  });
  it("returns the key itself for an unknown key (never throws)", () => {
    expect(getMessage("en", "does.not.exist")).toBe("does.not.exist");
  });
});

describe("getMessages + translate", () => {
  it("returns a plain catalog object that translate() can look up + interpolate", () => {
    const messages = getMessages("en");
    expect(typeof messages).toBe("object");
    expect(translate(messages, "email.fallback.subject.quickUpdate", { name: "Beta" })).toBe(
      "A quick update from Beta",
    );
    expect(translate(messages, "missing.key")).toBe("missing.key");
  });
  it("falls back to the English base for an untranslated locale", () => {
    expect(getMessages("pt")["email.fallback.subject.default"]).toBe(
      getMessages("en")["email.fallback.subject.default"],
    );
  });
});

describe("shipped locale catalogs", () => {
  const en = getMessages("en");
  const tokens = (s: string) =>
    [
      ...(s.match(/\{\{[\w.]+\}\}/g) ?? []),
      ...(s.match(/(?<!\{)\{[a-zA-Z0-9_]+\}(?!\})/g) ?? []),
    ]
      .sort()
      .join(",");

  for (const loc of ["fr", "es", "de", "ja", "ar"]) {
    it(`${loc}: every translated value preserves its {{tokens}} + {placeholders}`, () => {
      const cat = getMessages(loc);
      for (const key of Object.keys(en)) {
        if (cat[key] !== undefined && cat[key] !== en[key]) {
          expect(tokens(cat[key]!), `${loc} · ${key}`).toBe(tokens(en[key]!));
        }
      }
    });
    it(`${loc}: is actually wired in (differs from English)`, () => {
      expect(getMessages(loc)["widget.signup.join"]).not.toBe(en["widget.signup.join"]);
    });
  }
});

describe("getWidgetMessages", () => {
  it("includes only widget.* keys (keeps transactional email copy out of the client bundle)", () => {
    const w = getWidgetMessages("en");
    const keys = Object.keys(w);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith("widget."))).toBe(true);
    expect(w["widget.signup.join"]).toBe("Join");
    expect(w["email.verify.button"]).toBeUndefined();
    expect(w["email.fallback.subject.default"]).toBeUndefined();
  });
});

describe("widget catalog — English byte-identity guard", () => {
  // Locks the exact English strings the widget renders so a future translation
  // edit (or a refactor) can't silently change the live English experience.
  it("resolves the core widget labels to their exact current English", () => {
    const m = getMessages("en");
    expect(translate(m, "widget.signup.join")).toBe("Join");
    expect(translate(m, "widget.signup.joining")).toBe("Joining…");
    expect(translate(m, "widget.signup.email")).toBe("Email");
    expect(translate(m, "widget.signup.emailPlaceholder")).toBe("you@example.com");
    expect(translate(m, "widget.signup.verify.title")).toBe("Almost there — check your email 📧");
    expect(translate(m, "widget.success.onList")).toBe("You're on the list!");
    expect(translate(m, "widget.success.alreadyOnList")).toBe("You're already on the list 🎉");
    expect(translate(m, "widget.share.position")).toBe("Your position");
    expect(translate(m, "widget.share.copy")).toBe("Copy");
    expect(translate(m, "widget.share.copied")).toBe("Copied");
    expect(translate(m, "widget.status.checkStatus")).toBe("Check your status");
    expect(translate(m, "widget.voice.endSave")).toBe("End & save");
    expect(translate(m, "widget.leaderboard.title")).toBe("Top referrers");
    expect(translate(m, "widget.closed.message")).toBe(
      "This waitlist is closed and is no longer accepting signups.",
    );
  });
  it("renders the interpolated/pluralized lines exactly as before", () => {
    const m = getMessages("en");
    expect(translate(m, "widget.header.joinOthers", { count: "1,000" })).toBe(
      "Join 1,000 others on the waitlist.",
    );
    expect(translate(m, "widget.success.joinedCount", { count: "1,000" })).toBe(
      "1,000 people have joined.",
    );
    // Referral count line — both plural arms (number injected separately as markup).
    expect(pluralText(m, "en", 1, "widget.share.referred")).toBe("You have referred 1 friend.");
    expect(pluralText(m, "en", 3, "widget.share.referred")).toBe("You have referred 3 friends.");
    expect(pluralText(m, "en", 1, "widget.leaderboard.referrals")).toBe("1 referral");
    expect(pluralText(m, "en", 5, "widget.leaderboard.referrals")).toBe("5 referrals");
  });
  it("keeps {{merge_tokens}} verbatim in catalog copy", () => {
    const m = getMessages("en");
    expect(translate(m, "email.fallback.body.greeting")).toBe("Hi {{first_name}},");
    expect(translate(m, "widget.voice.bumpedWithRank", { rank: 7 })).toBe(
      " We bumped you up the queue to #7.",
    );
  });
});

describe("pluralCategory + pluralText", () => {
  it("selects English plural categories", () => {
    expect(pluralCategory("en", 1)).toBe("one");
    expect(pluralCategory("en", 2)).toBe("other");
    expect(pluralCategory("en", 0)).toBe("other");
  });
  it("uses English plural rules for an unknown/normalised-away locale", () => {
    // normalizeLocale("xx") → null → English rules (not a crash).
    expect(pluralCategory("xx", 1)).toBe("one");
    expect(pluralCategory(null, 3)).toBe("other");
  });
  it("renders the right plural form with {count} interpolated", () => {
    const messages = {
      "t.one": "{count} item",
      "t.other": "{count} items",
    };
    expect(pluralText(messages, "en", 1, "t")).toBe("1 item");
    expect(pluralText(messages, "en", 5, "t")).toBe("5 items");
  });
});
