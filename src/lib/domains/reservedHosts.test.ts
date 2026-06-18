import { describe, it, expect, afterEach } from "vitest";
import { isReservedHost } from "./reservedHosts";

const ORIGINAL = process.env.NEXT_PUBLIC_PLATFORM_ORIGIN;
const ORIGINAL_RESERVED = process.env.PLATFORM_RESERVED_DOMAINS;

afterEach(() => {
  process.env.NEXT_PUBLIC_PLATFORM_ORIGIN = ORIGINAL;
  process.env.PLATFORM_RESERVED_DOMAINS = ORIGINAL_RESERVED;
});

describe("isReservedHost", () => {
  it("blocks platform-infra hosts, localhost and IPs", () => {
    expect(isReservedHost("foo.hosted.app")).toBe(true);
    expect(isReservedHost("x.web.app")).toBe(true);
    expect(isReservedHost("svc.run.app")).toBe(true);
    expect(isReservedHost("localhost")).toBe(true);
    expect(isReservedHost("127.0.0.1")).toBe(true);
    expect(isReservedHost("::1")).toBe(true);
    expect(isReservedHost("")).toBe(true);
  });

  it("blocks the platform host and its subdomains", () => {
    process.env.NEXT_PUBLIC_PLATFORM_ORIGIN = "https://yougrow.ai";
    expect(isReservedHost("yougrow.ai")).toBe(true);
    expect(isReservedHost("app.yougrow.ai")).toBe(true);
    expect(isReservedHost("acme.com")).toBe(false);
  });

  it("honours the PLATFORM_RESERVED_DOMAINS env list", () => {
    process.env.PLATFORM_RESERVED_DOMAINS = "vizzybl.app, example.dev";
    expect(isReservedHost("vizzybl.app")).toBe(true);
    expect(isReservedHost("sub.example.dev")).toBe(true);
    expect(isReservedHost("acme.com")).toBe(false);
  });
});
