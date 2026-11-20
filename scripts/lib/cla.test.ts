import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import {
  checkCla,
  coAuthors,
  failedResult,
  flatten,
  ghContentArgs,
  ghListArgs,
  ghPullArgs,
  isPromotion,
  noreplyLogin,
  parseCheckArgs,
  parsePolicy,
  parseSignature,
  summaryMarkdown,
  trustedRef,
} from "./cla.mjs";

// The live check is scripts/check-cla.mjs, run by .github/workflows/cla.yml on pull requests.
// Everyone here is made up.

const REPO = "example-org/example-repo";
const OWNER = "maintainer-one";
const HEAD_SHA = "a".repeat(40);
const AI_TRAILER = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

const POLICY = {
  version: 1,
  accepted: ["individual-v1", "entity-v1"],
  exempt: [
    { login: OWNER, why: "the maintainer's own account" },
    { login: "dependabot[bot]", why: "dependency updates" },
    { login: "github-actions[bot]", why: "this repository's workflows" },
  ],
  ai: { emails: ["noreply@anthropic.com"], logins: ["claude"] },
  entities: [{ id: "example-co", cla: "entity-v1", signedAt: "2026-11-01", logins: ["co-dev"], recordedBy: OWNER }],
};

const sig = (login: string, extra: Record<string, unknown> = {}) => JSON.stringify({ login, cla: "individual-v1", signedAt: "2026-11-02", ...extra });

type Files = Record<string, string>;
type FakeCommit = { sha?: string; author?: { login?: string } | null; commit?: { author?: { email?: string } | null; message?: string } };
type FakeFile = { filename: string; status: string; previous_filename?: string };

let shaCounter = 0;
function commit(login: string | null, email: string, message = "feat: a change"): FakeCommit {
  shaCounter += 1;
  const sha = shaCounter.toString(16).padStart(7, "0") + "f".repeat(33);
  return { sha, author: login === null ? null : { login }, commit: { author: { email }, message } };
}

function pull(author: string, opts: { base?: string; head?: string; headRepo?: string; commits?: number; files?: number } = {}) {
  return {
    user: { login: author },
    base: { ref: opts.base ?? "dev", sha: "b".repeat(40), repo: { full_name: REPO } },
    head: { ref: opts.head ?? `feat/${author}`, sha: HEAD_SHA, repo: { full_name: opts.headRepo ?? REPO } },
    commits: opts.commits ?? 0,
    changed_files: opts.files ?? 0,
  };
}

/** Fake readers: trusted files by ref (as the entry script reads at trustedRef), head files by path. */
function readers(trusted: Record<string, Files>, head: Files = {}, p?: ReturnType<typeof pull>) {
  return {
    readTrusted: (path: string) => {
      const ref = p ? trustedRef(p) : "dev";
      return trusted[ref ?? ""]?.[path] ?? null;
    },
    readHead: (path: string) => head[path] ?? null,
  };
}

const base = (extra: Files = {}): Files => ({ "docs/cla/policy.json": JSON.stringify(POLICY), ...extra });

async function run(
  p: ReturnType<typeof pull>,
  commits: FakeCommit[],
  files: FakeFile[],
  trusted: Record<string, Files> = { dev: base(), main: base() },
  head: Files = {},
) {
  p.commits = commits.length;
  p.changed_files = files.length;
  return checkCla({ pull: p, commits, files }, readers(trusted, head, p));
}

const someFile: FakeFile = { filename: "src/lib/thing.ts", status: "modified" };

describe("checkCla: who is covered", () => {
  it("passes an owner pull request whose commits carry Claude Co-authored-by lines", async () => {
    const r = await run(pull(OWNER), [commit(OWNER, "owner@example.com", `feat: x\n\n${AI_TRAILER}`), commit(OWNER, "owner@example.com", `fix: y\n\n${AI_TRAILER}`)], [someFile]);
    expect(r.ok).toBe(true);
    expect(r.covered).toEqual([{ login: OWNER, how: "exempt" }]);
  });

  it("fails an unsigned outside author, and the summary names them and gives the steps", async () => {
    const r = await run(pull("new-person"), [commit("new-person", "new@example.com")], [someFile]);
    expect(r.ok).toBe(false);
    expect(r.uncovered).toEqual(["new-person"]);
    const md = summaryMarkdown(r);
    expect(md).toContain("`new-person`");
    expect(md).toContain("### How to sign");
    expect(md).toContain("`docs/cla/signatures/new-person.json`");
    expect(md).toContain('{ "login": "new-person", "cla": "individual-v1", "signedAt": "YYYY-MM-DD" }');
    expect(md).toContain("docs/cla/individual.md");
    expect(md).toContain("renamed your GitHub account");
    expect(md).not.toContain("### How others sign");
  });

  it("tells an unsigned commit author who isn't the pull request's author to sign in a pull request of their own", async () => {
    const trusted = { dev: base({ "docs/cla/signatures/alice.json": sig("alice") }) };
    const commits = [commit("alice", "alice@example.test"), commit("bob", "bob@example.test")];
    const r = await run(pull("alice"), commits, [someFile], trusted);
    expect(r.ok).toBe(false);
    expect(r.uncovered).toEqual(["bob"]);
    const md = summaryMarkdown(r);
    expect(md).toContain("`bob`");
    expect(md).not.toContain("In this pull request, add the file");
    expect(md).toContain("### How others sign");
    expect(md).toContain("a pull request of their own");
    expect(md).toContain("`docs/cla/signatures/bob.json`");
    expect(md).toContain("renamed your GitHub account");

    // Why: this pull request may not add bob's file.
    const withBobsFile = await run(pull("alice"), commits, [someFile, { filename: "docs/cla/signatures/bob.json", status: "added" }], trusted, {
      "docs/cla/signatures/bob.json": sig("bob"),
    });
    expect(withBobsFile.ok).toBe(false);
    expect(withBobsFile.register).toEqual(["docs/cla/signatures/bob.json"]);
  });

  it("gives both sets of steps when the author and someone else are not covered", async () => {
    const r = await run(pull("new-person"), [commit("new-person", "new@example.com"), commit("bob", "bob@example.test")], [someFile]);
    expect(r.uncovered).toEqual(["new-person", "bob"]);
    const md = summaryMarkdown(r);
    expect(md).toContain("In this pull request, add the file `docs/cla/signatures/new-person.json`");
    expect(md).toContain("### How others sign");
    expect(md).toContain("`docs/cla/signatures/bob.json`");
  });

  it("passes a login with a trusted signature file", async () => {
    const trusted = { dev: base({ "docs/cla/signatures/signed-person.json": sig("Signed-Person") }) };
    const r = await run(pull("Signed-Person"), [commit("Signed-Person", "signed@example.com")], [someFile], trusted);
    expect(r.ok).toBe(true);
    expect(r.covered).toEqual([{ login: "Signed-Person", how: "signed" }]);
  });

  it("passes a login an organisation's agreement names", async () => {
    const r = await run(pull("co-dev"), [commit("co-dev", "dev@example.com")], [someFile]);
    expect(r.ok).toBe(true);
    expect(r.covered[0]).toEqual({ login: "co-dev", how: "an organisation's agreement" });
  });

  it("passes dependabot[bot]", async () => {
    const r = await run(pull("dependabot[bot]"), [commit("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")], [{ filename: "package.json", status: "modified" }]);
    expect(r.ok).toBe(true);
  });

  it("ignores a trusted signature that isn't valid or names an agreement that isn't accepted", async () => {
    for (const bad of [sig("someone-else"), sig("bad-sig", { cla: "individual-v9" }), "not json"]) {
      const trusted = { dev: base({ "docs/cla/signatures/bad-sig.json": bad }) };
      const r = await run(pull("bad-sig"), [commit("bad-sig", "bad@example.com")], [someFile], trusted);
      expect(r.ok, bad).toBe(false);
    }
  });
});

describe("checkCla: commits", () => {
  it("fails a commit with no linked GitHub account and a human email, naming only the short sha", async () => {
    const c = commit(null, "private-person@example.com");
    const r = await run(pull(OWNER), [c], [someFile]);
    expect(r.ok).toBe(false);
    expect(r.unlinked).toEqual([c.sha!.slice(0, 7)]);
    const md = summaryMarkdown(r);
    expect(md).toContain(c.sha!.slice(0, 7));
    expect(md).not.toContain("private-person");
  });

  it("counts a commit by the claude login with Anthropic's address as the pull request author's", async () => {
    const ai = () => commit("claude", "noreply@anthropic.com");
    const owner = await run(pull(OWNER), [ai()], [someFile]);
    expect(owner.ok).toBe(true);
    expect(owner.aiCommits).toBe(1);
    const outsider = await run(pull("new-person"), [ai()], [someFile]);
    expect(outsider.ok).toBe(false);
    expect(outsider.uncovered).toEqual(["new-person"]);
  });

  it("counts an unlinked commit from an AI address, in any letter case, as the author's", async () => {
    const r = await run(pull(OWNER), [commit(null, "NoReply@Anthropic.com")], [someFile]);
    expect(r.ok).toBe(true);
  });
});

describe("checkCla: co-authors", () => {
  it("ignores an AI Co-authored-by line, matching the address in any letter case", async () => {
    const r = await run(pull(OWNER), [commit(OWNER, "owner@example.com", "x\n\nco-authored-by: Claude <NOREPLY@ANTHROPIC.COM>")], [someFile]);
    expect(r.ok).toBe(true);
  });

  it("passes a human co-author's noreply address when that login signed, and fails it when not", async () => {
    const trusted = { dev: base({ "docs/cla/signatures/helper.json": sig("helper") }) };
    const signed = await run(pull(OWNER), [commit(OWNER, "owner@example.com", "x\n\nCo-authored-by: Helper <12345+Helper@users.noreply.github.com>")], [someFile], trusted);
    expect(signed.ok).toBe(true);

    const c = commit(OWNER, "owner@example.com", "x\n\nCo-authored-by: Unsigned <unsigned-one@users.noreply.github.com>");
    const unsigned = await run(pull(OWNER), [c], [someFile]);
    expect(unsigned.ok).toBe(false);
    expect(unsigned.coAuthors).toEqual([c.sha!.slice(0, 7)]);
    expect(unsigned.uncovered).toEqual(["unsigned-one"]);
  });

  it("fails a human co-author with an unlinked address, naming only the sha", async () => {
    const c = commit(OWNER, "owner@example.com", "x\n\nCo-authored-by: Pat Example <pat@example.test>");
    const r = await run(pull(OWNER), [c], [someFile]);
    expect(r.ok).toBe(false);
    expect(r.coAuthors).toEqual([c.sha!.slice(0, 7)]);
    const md = summaryMarkdown(r);
    expect(md).toContain(c.sha!.slice(0, 7));
    expect(md).not.toContain("Pat Example");
    expect(md).not.toContain("pat@example.test");
    // The author is covered, so the steps are for the co-author, in a pull request of their own.
    expect(md).not.toContain("In this pull request, add the file");
    expect(md).toContain("### How others sign");
  });

  it("passes that address when it is the commit's own author address, or a covered commit author's", async () => {
    const own = await run(pull(OWNER), [commit(OWNER, "owner@example.com", "x\n\nCo-authored-by: Me <OWNER@example.com>")], [someFile]);
    expect(own.ok).toBe(true);

    const trusted = { dev: base({ "docs/cla/signatures/helper.json": sig("helper") }) };
    const other = await run(
      pull(OWNER),
      [commit("helper", "helper@example.test"), commit(OWNER, "owner@example.com", "x\n\nCo-authored-by: Helper <helper@example.test>")],
      [someFile],
      trusted,
    );
    expect(other.ok).toBe(true);
  });

  it("fails a co-author line with no address", async () => {
    const r = await run(pull(OWNER), [commit(OWNER, "owner@example.com", "x\n\nCo-authored-by: someone")], [someFile]);
    expect(r.ok).toBe(false);
    expect(r.coAuthors).toHaveLength(1);
  });

  it("fails a co-author line with more than one address, even when the last is an AI tool's", async () => {
    for (const line of ["Co-authored-by: Pat <pat@example.test>, Claude <noreply@anthropic.com>", "Co-authored-by: Pat Example <pat@example.test> <noreply@anthropic.com>"]) {
      const r = await run(pull(OWNER), [commit(OWNER, "owner@example.com", `x\n\n${line}`)], [someFile]);
      expect(r.ok, line).toBe(false);
      expect(r.coAuthors, line).toHaveLength(1);
    }
  });
});

describe("checkCla: signing in the pull request", () => {
  const own = (login: string): FakeFile => ({ filename: `docs/cla/signatures/${login}.json`, status: "added" });

  it("passes a pull request that adds its author's own valid file", async () => {
    const r = await run(pull("New-Person"), [commit("New-Person", "new@example.com")], [someFile, own("new-person")], undefined, {
      "docs/cla/signatures/new-person.json": sig("New-Person"),
    });
    expect(r.ok).toBe(true);
    expect(r.covered).toEqual([{ login: "New-Person", how: "signing in this pull request" }]);
  });

  it("fails that file with a wrong login, an extra key or an agreement that isn't accepted", async () => {
    for (const bad of [sig("someone-else"), sig("new-person", { name: "Pat" }), sig("new-person", { cla: "individual-v2" }), sig("new-person", { cla: "entity-v1" }), sig("new-person", { signedAt: "2026-02-30" })]) {
      const r = await run(pull("new-person"), [commit("new-person", "new@example.com")], [own("new-person")], undefined, { "docs/cla/signatures/new-person.json": bad });
      expect(r.ok, bad).toBe(false);
      expect(r.ownSignature, bad).toContain("docs/cla/signatures/new-person.json");
      expect(summaryMarkdown(r), bad).toContain("**Your signature file:**");
    }
  });

  it("fails a pull request that adds someone else's file", async () => {
    const r = await run(pull("new-person"), [commit("new-person", "new@example.com")], [own("new-person"), own("other-person")], undefined, {
      "docs/cla/signatures/new-person.json": sig("new-person"),
      "docs/cla/signatures/other-person.json": sig("other-person"),
    });
    expect(r.ok).toBe(false);
    expect(r.register).toEqual(["docs/cla/signatures/other-person.json"]);
  });

  it("fails a file name that isn't the login in lower case", async () => {
    const r = await run(pull("New-Person"), [commit("New-Person", "new@example.com")], [own("New-Person")], undefined, {
      "docs/cla/signatures/New-Person.json": sig("New-Person"),
    });
    expect(r.ok).toBe(false);
    expect(r.register).toEqual(["docs/cla/signatures/New-Person.json"]);
  });

  it("fails a pull request that changes the policy, a CLA text, the README or any signature, unless the author is exempt", async () => {
    const trusted = { dev: base({ "docs/cla/signatures/signed-person.json": sig("signed-person") }) };
    const changes: FakeFile[] = [
      { filename: "docs/cla/policy.json", status: "modified" },
      { filename: "docs/cla/individual.md", status: "modified" },
      { filename: "docs/cla/signatures/README.md", status: "modified" },
      { filename: "docs/cla/signatures/signed-person.json", status: "modified" },
      { filename: "docs/cla/signatures/someone.json", status: "removed" },
      { filename: "docs/cla/signatures/moved.json", status: "renamed", previous_filename: "docs/cla/signatures/someone.json" },
      { filename: "docs/elsewhere.json", status: "renamed", previous_filename: "docs/cla/signatures/third.json" },
    ];
    for (const f of changes) {
      const r = await run(pull("signed-person"), [commit("signed-person", "signed@example.com")], [f], trusted);
      expect(r.ok, f.filename).toBe(false);
      expect(r.register, f.filename).toEqual([f.filename]);
    }
    const exempt = await run(pull(OWNER), [commit(OWNER, "owner@example.com")], changes);
    expect(exempt.ok).toBe(true);
  });

  it("passes a stale branch: a signature merged to the base since isn't in its file list", async () => {
    const trusted = { dev: base({ "docs/cla/signatures/early-signer.json": sig("early-signer"), "docs/cla/signatures/signed-person.json": sig("signed-person") }) };
    const r = await run(pull("signed-person"), [commit("signed-person", "signed@example.com")], [someFile], trusted);
    expect(r.ok).toBe(true);
  });

  it("passes two people signing at once, alone and after the other merges", async () => {
    const pr = (login: string) => run(pull(login), [commit(login, `${login}@example.com`)], [own(login)], undefined, { [`docs/cla/signatures/${login}.json`]: sig(login) });
    expect((await pr("first-signer")).ok).toBe(true);
    expect((await pr("second-signer")).ok).toBe(true);

    // The first merges: the second pull request's file list still holds only its own file.
    const merged = { dev: base({ "docs/cla/signatures/first-signer.json": sig("first-signer") }) };
    const second = await run(pull("second-signer"), [commit("second-signer", "second@example.com")], [own("second-signer")], merged, {
      "docs/cla/signatures/second-signer.json": sig("second-signer"),
    });
    expect(second.ok).toBe(true);
  });
});

describe("checkCla: promotions", () => {
  const outsideCommit = () => commit("outside-dev", "outside@example.com");
  const onDev = { [HEAD_SHA]: base({ "docs/cla/signatures/outside-dev.json": sig("outside-dev") }), main: base() };

  it("reads signatures at dev's head commit for dev to main in the same repository", async () => {
    const p = pull(OWNER, { base: "main", head: "dev" });
    expect(isPromotion(p)).toBe(true);
    expect(trustedRef(p)).toBe(HEAD_SHA);
    const r = await run(p, [outsideCommit(), commit(OWNER, "owner@example.com")], [someFile, { filename: "docs/cla/signatures/outside-dev.json", status: "added" }], onDev);
    expect(r.ok).toBe(true);
    expect(r.promotion).toBe(true);
    expect(summaryMarkdown(r)).toContain("promotes dev to main");
  });

  it("doesn't treat a fork's branch named dev as a promotion", async () => {
    const p = pull("fork-owner", { base: "main", head: "dev", headRepo: "fork-owner/example-repo" });
    expect(isPromotion(p)).toBe(false);
    expect(trustedRef(p)).toBe("main");
    const r = await run(p, [outsideCommit()], [someFile], onDev);
    expect(r.ok).toBe(false);
    expect(r.uncovered).toEqual(["fork-owner", "outside-dev"]);
  });

  it("uses the base branch name, not its sha, for other pull requests", () => {
    expect(trustedRef(pull(OWNER, { base: "main" }))).toBe("main");
    expect(trustedRef(pull(OWNER, { base: "dev" }))).toBe("dev");
    expect(trustedRef(pull(OWNER, { base: "release" }))).toBeNull();
    expect(isPromotion({ ...pull(OWNER, { base: "main", head: "dev" }), head: { ref: "dev", sha: HEAD_SHA, repo: null } })).toBe(false);
  });
});

describe("checkCla: fails closed", () => {
  it("when GitHub listed fewer commits than the pull request has (the 250 cap)", async () => {
    const p = pull(OWNER);
    const r = await checkCla({ pull: { ...p, commits: 251, changed_files: 1 }, commits: [commit(OWNER, "owner@example.com")], files: [someFile] }, readers({ dev: base() }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("250");
  });

  it("when GitHub listed fewer files than changed (the 3000 cap)", async () => {
    const p = pull(OWNER);
    const r = await checkCla({ pull: { ...p, commits: 1, changed_files: 3001 }, commits: [commit(OWNER, "owner@example.com")], files: [someFile] }, readers({ dev: base() }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("3000");
  });

  it("when the base isn't dev or main", async () => {
    const r = await run(pull(OWNER, { base: "release" }), [commit(OWNER, "owner@example.com")], [someFile]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("not to dev or main");
  });

  it("when the policy is missing or invalid", async () => {
    const missing = await run(pull(OWNER), [commit(OWNER, "owner@example.com")], [someFile], { dev: {} });
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toContain("docs/cla/policy.json is missing at dev");
    for (const bad of ["{", "[]", JSON.stringify({ ...POLICY, version: 2 }), JSON.stringify({ ...POLICY, exempt: [{ login: OWNER }] }), JSON.stringify({ ...POLICY, ai: { emails: "x" } })]) {
      const r = await run(pull(OWNER), [commit(OWNER, "owner@example.com")], [someFile], { dev: { "docs/cla/policy.json": bad } });
      expect(r.ok, bad).toBe(false);
      expect(r.errors[0], bad).toContain("docs/cla/policy.json at dev");
    }
  });

  it("when the pull request or a file can't be read", async () => {
    expect((await checkCla({ pull: null, commits: [], files: [] }, readers({}))).errors).toEqual(["The pull request could not be read."]);
    const throws = {
      readTrusted: () => {
        throw new Error("gh could not read docs/cla/policy.json at dev: HTTP 502");
      },
      readHead: () => null,
    };
    const p = pull(OWNER);
    const r = await checkCla({ pull: { ...p, commits: 1, changed_files: 1 }, commits: [commit(OWNER, "owner@example.com")], files: [someFile] }, throws);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("HTTP 502");
  });
});

describe("parsing", () => {
  it("reads the policy in this repository", () => {
    const parsed = parsePolicy(readFileSync("docs/cla/policy.json", "utf8"));
    expect(parsed.error).toBeUndefined();
    expect(parsed.policy?.accepted).toEqual(["individual-v1", "entity-v1"]);
    expect(parsed.policy?.exempt.map((e) => e.login)).toEqual(["ygai-jezl", "dependabot[bot]", "github-actions[bot]"]);
    expect(parsed.policy?.ai.emails).toEqual(["noreply@anthropic.com"]);
  });

  it("refuses a policy entity whose agreement isn't an entity one", () => {
    expect(parsePolicy(JSON.stringify({ ...POLICY, entities: [{ ...POLICY.entities[0], cla: "individual-v1" }] })).error).toBeDefined();
  });

  it("reads a signature with exactly three keys, the login in any case and a real date", () => {
    expect(parseSignature(sig("Some-Login"), "some-login").signature).toEqual({ login: "Some-Login", cla: "individual-v1", signedAt: "2026-11-02" });
    expect(parseSignature(sig("x", { email: "x@example.com" }), "x").error).toContain("exactly");
    expect(parseSignature(sig("x", { signedAt: "2026-13-01" }), "x").error).toContain("signedAt");
    expect(parseSignature("[]", "x").error).toBeDefined();
  });

  it("finds each Co-authored-by address, in lower case", () => {
    expect(coAuthors("feat: x\n\nbody\n\nCo-authored-by: A <A@Example.com>\nco-authored-by: B <b@example.com>\nCo-Authored-By: no address")).toEqual(["a@example.com", "b@example.com", ""]);
    expect(coAuthors(undefined)).toEqual([]);
    expect(coAuthors("x\n\nCo-authored-by: Pat <pat@example.test>, Claude <noreply@anthropic.com>")).toEqual([""]);
    expect(coAuthors("x\n\nCo-authored-by: Pat <<pat@example.test>")).toEqual([""]);
  });

  it("reads the login in a GitHub noreply address", () => {
    expect(noreplyLogin("12345+Some-Login@users.noreply.github.com")).toBe("some-login");
    expect(noreplyLogin("some-login@users.noreply.github.com")).toBe("some-login");
    expect(noreplyLogin("49699333+dependabot[bot]@users.noreply.github.com")).toBe("dependabot[bot]");
    expect(noreplyLogin("../policy@users.noreply.github.com")).toBeNull();
    expect(noreplyLogin("someone@example.com")).toBeNull();
  });

  it("flattens gh's --slurp pages", () => {
    expect(flatten([[1, 2], [3], []])).toEqual([1, 2, 3]);
    expect(() => flatten({ message: "Not Found" })).toThrow();
    expect(() => flatten([{ sha: "x" }])).toThrow();
  });
});

describe("gh arguments", () => {
  const all = [ghContentArgs(REPO, "docs/cla/policy.json", "refs/pull/7/head"), ghListArgs(REPO, "7", "commits"), ghListArgs(REPO, "7", "files"), ghPullArgs(REPO, "7")];

  it("only ever make GET requests", () => {
    for (const args of all) {
      for (const flag of ["-f", "-F", "--field", "--raw-field", "--method", "-X", "--input"]) expect(args, flag).not.toContain(flag);
      expect(args.some((a) => /^--(?:field|raw-field|method|input)=/.test(a))).toBe(false);
    }
  });

  it("put the ref in the query string", () => {
    expect(ghContentArgs(REPO, "docs/cla/signatures/dependabot[bot].json", "refs/pull/7/head")).toEqual([
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${REPO}/contents/docs/cla/signatures/dependabot%5Bbot%5D.json?ref=refs%2Fpull%2F7%2Fhead`,
    ]);
    expect(ghListArgs(REPO, "7", "files")).toEqual(["api", "--paginate", "--slurp", `repos/${REPO}/pulls/7/files?per_page=100`]);
  });

  it("refuse a bad repository, number or list", () => {
    expect(() => ghPullArgs("../..", "7")).toThrow();
    expect(() => ghListArgs(REPO, "7", "comments" as "files")).toThrow();
    expect(() => ghContentArgs("not a repo", "x", "dev")).toThrow();
  });
});

describe("the command line", () => {
  it("accepts a repository and a pull request number", () => {
    expect(parseCheckArgs(["--repo", REPO, "--pr", "194"])).toEqual({ repo: REPO, pr: "194", summary: "", trustedDir: "" });
    expect(parseCheckArgs(["--repo", REPO, "--pr", "5", "--summary", "/tmp/summary.md", "--trusted-dir", "docs/cla"])).toMatchObject({ summary: "/tmp/summary.md", trustedDir: "docs/cla" });
  });

  it("refuses a bad pull request number or repository", () => {
    for (const pr of ["1;rm", "0", "", "-1", "01", "1 2"]) expect(() => parseCheckArgs(["--repo", REPO, "--pr", pr]), pr).toThrow();
    for (const repo of ["owner", "owner/name/extra", "owner/na me", "../name", "owner/..", "$(x)/y"]) expect(() => parseCheckArgs(["--repo", repo, "--pr", "1"]), repo).toThrow();
    expect(() => parseCheckArgs(["--pr", "1"])).toThrow();
    expect(() => parseCheckArgs(["--repo", REPO, "--pr", "1", "--unknown", "x"])).toThrow();
    expect(() => parseCheckArgs(["--repo", REPO, "--pr", "1", "extra"])).toThrow();
  });
});

describe("summaryMarkdown", () => {
  it("follows the house style in every case", async () => {
    const results = [
      await run(pull(OWNER), [commit(OWNER, "owner@example.com")], [someFile]),
      await run(pull("new-person"), [commit(null, "a@example.test", "x\n\nCo-authored-by: B <b@example.test>")], [{ filename: "docs/cla/policy.json", status: "modified" }]),
      await run(pull(OWNER, { base: "main", head: "dev" }), [commit(OWNER, "owner@example.com")], [someFile], { [HEAD_SHA]: base() }),
      failedResult("The pull request could not be read."),
    ];
    for (const r of results) {
      const md = summaryMarkdown(r);
      expect(dashesIn(md), md).toEqual([]);
      expect(aiTellsIn(md), md).toEqual([]);
      expect(md).toContain("docs/cla/individual.md");
    }
  });

  it("keeps file names from the pull request inside code spans", async () => {
    const r = await run(pull("new-person"), [commit("new-person", "new@example.com")], [{ filename: "docs/cla/`[x](https://example.test)`\n.json", status: "added" }]);
    const md = summaryMarkdown(r);
    expect(md).toContain("`docs/cla/[x](https://example.test).json`");
  });
});
