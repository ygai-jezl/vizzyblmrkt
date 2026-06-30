import { describe, it, expect } from "vitest";
import { isPrivateIp } from "./ssrf";

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
