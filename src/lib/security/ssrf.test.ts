import { describe, it, expect, vi, afterEach } from "vitest";
import { assertSafeHttpsUrl, isPrivateIp, safeFetch } from "./ssrf";

describe("safeFetch rejects private IP-LITERAL hosts up front", () => {
  // Regression: Node skips the undici connect-time lookup hook for IP-literal hosts, so
  // isPrivateIp never runs for them — assertHttps must screen them itself. These reject
  // synchronously (before any socket), so no network is touched.
  it("blocks loopback / private / link-local / IPv6 literals", async () => {
    for (const url of [
      "https://127.0.0.1/",
      "https://127.0.0.1:6443/x",
      "https://10.0.0.10:8443/internal",
      "https://192.168.1.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/",
    ]) {
      await expect(safeFetch(url)).rejects.toThrow(/host_blocked/);
    }
  });

  it("still rejects non-https and localhost by name", async () => {
    await expect(safeFetch("http://example.com/")).rejects.toThrow(/scheme_not_https/);
    await expect(safeFetch("https://localhost/")).rejects.toThrow(/host_blocked/);
  });
});

describe("isPrivateIp (SSRF blocklist)", () => {
  it("blocks cloud metadata + private/loopback IPv4", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true); // GCP/AWS metadata
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.0.0.2")).toBe(true); // whole 127/8 (the review gap)
    expect(isPrivateIp("127.255.255.255")).toBe(true);
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("100.64.0.1")).toBe(true); // CGNAT
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  it("blocks loopback/link-local/ULA + IPv4-mapped IPv6 (the review bypasses)", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true); // mapped metadata
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:a9fe:a9fe")).toBe(true); // hex-mapped metadata
  });

  it("allows genuine public addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false); // public IPv6
  });

  it("rejects un-parseable input defensively", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });
});

describe("isPrivateIp — IPv6 forms that embed or tunnel an IPv4 address", () => {
  it("blocks NAT64 addresses that carry a private IPv4 (incl. cloud metadata)", () => {
    expect(isPrivateIp("64:ff9b::a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isPrivateIp("64:ff9b::169.254.169.254")).toBe(true);
    expect(isPrivateIp("64:ff9b::a00:1")).toBe(true); // 10.0.0.1
    expect(isPrivateIp("64:ff9b:1::1")).toBe(true); // local-use NAT64 prefix
  });

  it("blocks 6to4 addresses that carry a private IPv4", () => {
    expect(isPrivateIp("2002:7f00:1::")).toBe(true); // 127.0.0.1
    expect(isPrivateIp("2002:a9fe:a9fe::1")).toBe(true); // 169.254.169.254
  });

  it("blocks Teredo, IPv4-compatible, site-local, multicast and zoned link-local", () => {
    expect(isPrivateIp("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(true); // Teredo
    expect(isPrivateIp("::127.0.0.1")).toBe(true); // IPv4-compatible (deprecated)
    expect(isPrivateIp("::7f00:1")).toBe(true);
    expect(isPrivateIp("fec0::1")).toBe(true); // site-local (deprecated)
    expect(isPrivateIp("ff02::1")).toBe(true); // multicast
    expect(isPrivateIp("fe80::1%eth0")).toBe(true); // link-local with a zone id
  });

  it("still allows public IPv6, including NAT64/6to4 of a public IPv4", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false); // not Teredo (2001:0::/32)
    expect(isPrivateIp("64:ff9b::808:808")).toBe(false); // 8.8.8.8
    expect(isPrivateIp("2002:808:808::1")).toBe(false); // 8.8.8.8
  });
});

describe("isPrivateIp — extra IPv4 ranges", () => {
  it("blocks benchmarking 198.18/15 and IETF 192.0.0/24", () => {
    expect(isPrivateIp("198.18.0.1")).toBe(true);
    expect(isPrivateIp("198.19.255.255")).toBe(true);
    expect(isPrivateIp("192.0.0.170")).toBe(true); // NAT64 discovery
    expect(isPrivateIp("198.20.0.1")).toBe(false);
    expect(isPrivateIp("192.0.1.1")).toBe(false);
  });
});

describe("assertSafeHttpsUrl (save-time screen)", () => {
  it("enforces the port allowlist; an absent port means 443", () => {
    expect(() => assertSafeHttpsUrl("https://example.com:8443/ctx", { allowedPorts: [443] })).toThrow(
      /port_blocked/,
    );
    expect(assertSafeHttpsUrl("https://example.com/ctx", { allowedPorts: [443] }).hostname).toBe(
      "example.com",
    );
    expect(assertSafeHttpsUrl("https://example.com:443/ctx", { allowedPorts: [443] }).port).toBe("");
  });

  it("applies the same https, name and IP-literal rules as safeFetch", () => {
    expect(() => assertSafeHttpsUrl("http://example.com/")).toThrow(/scheme_not_https/);
    expect(() => assertSafeHttpsUrl("https://localhost/")).toThrow(/host_blocked/);
    expect(() => assertSafeHttpsUrl("https://[64:ff9b::a9fe:a9fe]/")).toThrow(/host_blocked/);
  });
});

describe("safeFetch for signed calls (no redirects, fixed port)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses to follow a redirect when maxRedirects is 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://example.com/next" } })),
    );
    await expect(safeFetch("https://example.com/ctx", {}, { maxRedirects: 0 })).rejects.toThrow(
      /too_many_redirects/,
    );
  });

  it("rejects a disallowed port before any request is made", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      safeFetch("https://example.com:8080/ctx", {}, { allowedPorts: [443] }),
    ).rejects.toThrow(/port_blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
