import { describe, it, expect } from "vitest";
import { evaluateCronAuth } from "./cronAuth";

// This gate has failed silently twice. Both directions matter: too narrow and
// the job 401s and quietly stops; too loose and a guest-facing job is exposed
// to anyone who can spell a header name.

const CRON_UA = "vercel-cron/1.0";

describe("evaluateCronAuth — no CRON_SECRET set", () => {
  it("accepts the x-vercel-cron header by PRESENCE, not by value", () => {
    // Vercel does not promise a particular value. `=== "1"` is a guess that
    // fails invisibly if it ever changes, so presence is the contract.
    expect(evaluateCronAuth({ xVercelCron: "1" }, undefined).isCron).toBe(true);
    expect(evaluateCronAuth({ xVercelCron: "" }, undefined).isCron).toBe(true);
    expect(evaluateCronAuth({ xVercelCron: "whatever" }, undefined).isCron).toBe(true);
  });

  it("accepts the documented cron user agent", () => {
    const r = evaluateCronAuth({ userAgent: CRON_UA }, undefined);
    expect(r.isCron).toBe(true);
    expect(r.via).toBe("user-agent");
  });

  it("flags header-only acceptance as unverified", () => {
    // Surfaced so the route can warn: these signals are forgeable.
    expect(evaluateCronAuth({ xVercelCron: "1" }, undefined).unverified).toBe(true);
    expect(evaluateCronAuth({ userAgent: CRON_UA }, undefined).unverified).toBe(true);
  });

  it("rejects an ordinary request", () => {
    const r = evaluateCronAuth({ userAgent: "Mozilla/5.0" }, undefined);
    expect(r).toEqual({ isCron: false, via: null, unverified: false });
    expect(evaluateCronAuth({}, undefined).isCron).toBe(false);
  });
});

describe("evaluateCronAuth — CRON_SECRET set", () => {
  const SECRET = "s3cret";

  it("accepts Vercel's Bearer token", () => {
    const r = evaluateCronAuth({ authorization: `Bearer ${SECRET}` }, SECRET);
    expect(r).toEqual({ isCron: true, via: "cron-secret", unverified: false });
  });

  it("STOPS honouring the forgeable signals once a secret exists", () => {
    // The whole point of configuring a secret. If the header still worked,
    // the secret would be decorative and the route would stay open.
    expect(evaluateCronAuth({ xVercelCron: "1" }, SECRET).isCron).toBe(false);
    expect(evaluateCronAuth({ userAgent: CRON_UA }, SECRET).isCron).toBe(false);
    expect(
      evaluateCronAuth({ xVercelCron: "1", userAgent: CRON_UA }, SECRET).isCron,
    ).toBe(false);
  });

  it("rejects a wrong or malformed token", () => {
    expect(evaluateCronAuth({ authorization: "Bearer nope" }, SECRET).isCron).toBe(false);
    expect(evaluateCronAuth({ authorization: SECRET }, SECRET).isCron).toBe(false);
    expect(evaluateCronAuth({ authorization: "" }, SECRET).isCron).toBe(false);
  });

  it("never reports unverified when a secret is in play", () => {
    expect(evaluateCronAuth({ authorization: `Bearer ${SECRET}` }, SECRET).unverified).toBe(false);
    expect(evaluateCronAuth({ xVercelCron: "1" }, SECRET).unverified).toBe(false);
  });
});
