import { describe, it, expect } from "vitest";
import { identityScrubber } from "./identityScrubber";

describe("identityScrubber", () => {
  it("takes out each part of the name, however it is written, and anything shaped like an address", () => {
    const scrub = identityScrubber({ name: "Jo Okafor-Lind", email: "jo.okafor@agency.test" });
    expect(scrub("Okafor-Lind Studio, set up by Jo")).toBe("[name]-[name] Studio, set up by [name]");
    expect(scrub("Billing: accounts@agency.test, owner jo.okafor")).toBe("Billing: [email], owner [name].[name]");
    expect(scrub("OKAFOR Bakery, okafor's account")).toBe("[name] Bakery, [name]'s account");
    expect(identityScrubber({})("nothing to hide")).toBe("nothing to hide");
  });

  it("takes out a short name written as a name, or beside the rest of it, and leaves the word it shares", () => {
    const li = identityScrubber({ name: "Li Wu" });
    expect(li("Li Wu signed up; Wu owns the account")).toBe("[name] [name] signed up; [name] owns the account");
    expect(li("li wu / WU, LI")).toBe("[name] [name] / [name], [name]");
    const an = identityScrubber({ name: "An Do" });
    expect(an("an email to do with billing")).toBe("an email to do with billing");
    expect(an("An has two brands")).toBe("[name] has two brands");
    expect(identityScrubber({ name: "Jo Okafor" })("Jo hates long emails")).toBe("[name] hates long emails");
  });

  it("reads a name that is also an everyday word as the word, until it is written as a name", () => {
    const scrub = identityScrubber({ name: "Will May", email: "team@harbour.test" });
    const plan = "We will lead with the benefit; they may want the team plan.";
    expect(scrub(plan)).toBe(plan);
    expect(scrub("Will runs the team; May signed up, then will.may did")).toBe("[name] runs the team; [name] signed up, then [name].[name] did");
    expect(scrub.names(plan)).toBe(false);
    expect(scrub.names("Will prefers short emails")).toBe(false);
    expect(scrub.names("Ask Will May directly")).toBe(true);
    expect(scrub.names("ask may, will")).toBe(true);
    expect(scrub.names("willmay on the forum")).toBe(true);
    const price = identityScrubber({ name: "Jo Price" });
    expect(price("lead with the price, and the prices page")).toBe("lead with the price, and the prices page");
    expect(price("Price hasn't opened one")).toBe("[name] hasn't opened one");
  });

  it("finds a part with punctuation on it, a nickname in brackets or quotes, and a suffix", () => {
    expect(identityScrubber({ name: "Sam Smithson, PhD" })("Dr Smithson replied")).toBe("Dr [name] replied");
    expect(identityScrubber({ name: "Jo (Joanna) Okafor" })("Joanna asked for a call")).toBe("[name] asked for a call");
    expect(identityScrubber({ name: 'Robert "Bobby" Tables' })("bobby's workspace")).toBe("[name]'s workspace");
  });

  it("takes accents, case and either apostrophe as written or not", () => {
    const ipek = identityScrubber({ name: "İpek Yılmaz" });
    expect(ipek("İpek, IPEK, ipek and Yilmaz")).toBe("[name], [name], [name] and [name]");
    const jose = identityScrubber({ name: "José Núñez" });
    // The same name, composed and decomposed, with and without its accents.
    expect(jose("José / JOSE / Nuñez / nunez")).toBe("[name] / [name] / [name] / [name]");
    const obrien = identityScrubber({ name: "Seán O’Brien" });
    expect(obrien("Sean O'Brien and O’BRIEN")).toBe("[name] O'[name] and O’[name]");
    expect(identityScrubber({ name: "Łukasz Straße" })("lukasz strasse")).toBe("[name] [name]");
  });

  it("finds a long name inside a longer word, a handle, and a domain", () => {
    const scrub = identityScrubber({ name: "Jo Okafor", email: "j.okafor88@agency.test" });
    expect(scrub("okaforplumbing.example, @jokafor, JoOkafor")).toBe("[name].example, @[name], [name]");
    expect(scrub("the handle jokafor88")).toBe("the handle [name]");
    // A shared mailbox's name is nobody's.
    expect(identityScrubber({ name: null, email: "team@agency.test" })("the team plan")).toBe("the team plan");
  });

  it("takes out an address in any script, or with its @ encoded", () => {
    const scrub = identityScrubber({});
    expect(scrub("al%40example.test, jörg@müller.example and 山田@例え.test")).toBe("[email], [email] and [email]");
    expect(scrub.names("write to someone@else.test")).toBe(true);
  });

  it("takes out a name in a script written without spaces wherever it appears", () => {
    const scrub = identityScrubber({ name: "田中 美咲" });
    expect(scrub("田中美咲さんのブランド、美咲のワークスペース")).toBe("[name]さんのブランド、[name]のワークスペース");
    expect(scrub.names("田中美咲さん")).toBe(true);
    // One character alone is too common to be anyone.
    expect(identityScrubber({ name: "王 伟" })("国王的品牌，王伟的品牌")).toBe("国王的品牌，[name]的品牌");
  });

  it("takes out the product's ids where they are quoted, but not one that is an ordinary word or number", () => {
    const scrub = identityScrubber({ userId: "u_8841", otherIds: ["main", "workspace-northlane-studio", "brand_771", "42", null] });
    expect(scrub("ref u_8841, not u_88410 or xu_8841")).toBe("ref [id], not u_88410 or xu_8841");
    expect(scrub("their main workspace is workspace-northlane-studio (brand_771), 42 days in")).toBe("their main workspace is [id] ([id]), 42 days in");
    // A sequential id reads as any other number; a username is theirs alone.
    expect(identityScrubber({ userId: "7" })('stuck on "Connect" for 7 days')).toBe('stuck on "Connect" for 7 days');
    expect(identityScrubber({ userId: "trailrunner" })("signed in as trailrunner")).toBe("signed in as [id]");
    expect(identityScrubber({ userId: "100234" })("account 100234")).toBe("account [id]");
  });

  it("says which words went as the name", () => {
    const scrub = identityScrubber({ name: "Priya Raman", email: "priya.raman@harbour.test" });
    const hidden = new Set<string>();
    expect(scrub("Priya opens everything; raman less so. Keep it short.", hidden)).toBe("[name] opens everything; [name] less so. Keep it short.");
    expect([...hidden]).toEqual(["Priya", "raman"]);
  });

  it("is safe with a name full of pattern characters", () => {
    const scrub = identityScrubber({ name: "A.*(b)+ [x] $^", email: "(a+b)*@weird.test", userId: "id(1)+" });
    expect(scrub("plain text stays plain, id(1)+ goes")).toBe("plain text stays plain, [id] goes");
  });
});
