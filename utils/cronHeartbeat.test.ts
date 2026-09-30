import { describe, it, expect } from "vitest";
import {
  staleCronJobs,
  unseededCronJobs,
  staleCronAlert,
  WATCHED_CRON_JOBS,
  type CronHeartbeat,
  type WatchedCronJob,
} from "./cronHeartbeat";

// The whole point of this watchdog is catching a cron that is not running at
// all — the failure that hid `send-due-invoices` for months. So the cases that
// matter most are the quiet ones: no heartbeat, and a heartbeat that stopped.

const JOBS: WatchedCronJob[] = [
  { job: "daily", label: "Daily job", maxAgeHours: 36 },
  { job: "other", label: "Other job", maxAgeHours: 36 },
];

const NOW = new Date("2026-09-30T12:00:00.000Z");
const hoursAgo = (h: number): CronHeartbeat => ({
  ranAt: new Date(NOW.getTime() - h * 3_600_000).toISOString(),
});

describe("staleCronJobs", () => {
  it("stays quiet while the job is reporting in", () => {
    expect(staleCronJobs({ daily: hoursAgo(3), other: hoursAgo(20) }, NOW, JOBS)).toEqual([]);
  });

  it("tolerates one missed run but not two", () => {
    // 36h threshold: a late or skipped daily run is not an alert...
    expect(staleCronJobs({ daily: hoursAgo(35) }, NOW, JOBS)).toEqual([]);
    // ...two in a row is.
    const stale = staleCronJobs({ daily: hoursAgo(40) }, NOW, JOBS);
    expect(stale).toHaveLength(1);
    expect(stale[0].job).toBe("daily");
    expect(stale[0].hoursSilent).toBe(40);
    expect(stale[0].reason).toBe("silent");
  });

  it("does not alert on a job it has never heard from — that gets seeded", () => {
    // Otherwise every fresh deploy fires an alert before any cron has had a
    // chance to run once.
    expect(staleCronJobs({ daily: null, other: null }, NOW, JOBS)).toEqual([]);
    expect(staleCronJobs({}, NOW, JOBS)).toEqual([]);
  });

  it("catches a seeded baseline that was never followed by a real run", () => {
    // The seed is not a free pass: if the job still doesn't run, the seed goes
    // stale and the alarm trips one window later.
    const seeded: CronHeartbeat = { ...hoursAgo(40), seeded: true };
    expect(staleCronJobs({ daily: seeded }, NOW, JOBS)).toHaveLength(1);
  });

  it("reports every silent job at once", () => {
    const stale = staleCronJobs({ daily: hoursAgo(40), other: hoursAgo(99) }, NOW, JOBS);
    expect(stale.map((s) => s.job)).toEqual(["daily", "other"]);
  });

  it("ignores an unparseable timestamp rather than alerting on junk", () => {
    expect(staleCronJobs({ daily: { ranAt: "not-a-date" } }, NOW, JOBS)).toEqual([]);
  });

  it("watches the two unblocked crons by default, not the payments one", () => {
    // send-scheduled-payments is deliberately still middleware-blocked, so
    // watching it would alert forever about a job nobody wants running yet.
    expect(WATCHED_CRON_JOBS.map((j) => j.job)).toEqual(["send-due-invoices", "check-reviews"]);
  });
});

describe("unseededCronJobs", () => {
  it("names the jobs with no baseline yet", () => {
    expect(unseededCronJobs({ daily: hoursAgo(1), other: null }, JOBS)).toEqual(["other"]);
    expect(unseededCronJobs({ daily: hoursAgo(1), other: hoursAgo(1) }, JOBS)).toEqual([]);
  });
});

describe("staleCronAlert", () => {
  it("says nothing when nothing is wrong", () => {
    expect(staleCronAlert([])).toBeNull();
  });

  it("names the job and points at the likely cause", () => {
    const body = staleCronAlert([
      { job: "send-due-invoices", label: "Invoice auto-send (09:00)", lastRanAt: "2026-09-28T09:00:00.000Z", hoursSilent: 51, reason: "silent" },
    ]);
    expect(body).toContain("Invoice auto-send (09:00)");
    expect(body).toContain("51h");
    // The 401/405/307 tell is the fastest diagnosis; keep it in the alert so
    // whoever reads it at 2am doesn't have to rediscover it.
    expect(body).toContain("405");
    expect(body).toContain("307");
    expect(body).toContain("proxy.ts");
  });

  it("carries no HTML-special characters — Telegram sends with parse_mode HTML", () => {
    const body = staleCronAlert([
      { job: "x", label: "Job & <thing>", lastRanAt: "2026-09-28T09:00:00.000Z", hoursSilent: 40, reason: "silent" },
    ])!;
    // Labels are ours, not user input, so the guard is on the template itself:
    // everything outside the label must be plain text.
    expect(body.replace("Job & <thing>", "")).not.toMatch(/[<>&]/);
  });
});

describe("staleCronJobs — invoked but not completing", () => {
  // A dying run now writes a heartbeat, so freshness alone stopped proving
  // health. Without this, a job timing out every day would stamp `started`
  // and look permanently alive — a new silent failure in place of the old one.
  it("flags a run stuck at `started` past the grace period", () => {
    const stuck = { ...hoursAgo(5), summary: { phase: "started" } };
    const stale = staleCronJobs({ daily: stuck }, NOW, JOBS);
    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toBe("not-completing");
  });

  it("leaves a genuinely in-flight run alone", () => {
    // maxDuration is 60s, so anything inside the 2h grace is still plausibly
    // mid-run — and alarming on it would fire every single morning.
    const running = { ...hoursAgo(0.2), summary: { phase: "started" } };
    expect(staleCronJobs({ daily: running }, NOW, JOBS)).toEqual([]);
  });

  it("flags a failed run and carries its error into the alert", () => {
    const failed = { ...hoursAgo(5), summary: { phase: "failed", error: "Beds24 502" } };
    const stale = staleCronJobs({ daily: failed }, NOW, JOBS);
    expect(stale[0].reason).toBe("not-completing");
    expect(stale[0].error).toBe("Beds24 502");
    expect(staleCronAlert(stale)).toContain("Beds24 502");
  });

  it("treats a completed run as healthy", () => {
    const done = { ...hoursAgo(5), summary: { phase: "completed", sent: 0 } };
    expect(staleCronJobs({ daily: done }, NOW, JOBS)).toEqual([]);
  });

  it("treats a phase-less legacy heartbeat as healthy", () => {
    // Rows written before phases existed must not start alarming on deploy.
    expect(staleCronJobs({ daily: hoursAgo(5) }, NOW, JOBS)).toEqual([]);
  });

  it("prefers `silent` when the job is BOTH stale and unfinished", () => {
    // Not invoked at all is the more actionable diagnosis of the two.
    const old = { ...hoursAgo(40), summary: { phase: "started" } };
    expect(staleCronJobs({ daily: old }, NOW, JOBS)[0].reason).toBe("silent");
  });

  it("words the two reasons differently", () => {
    const silent = staleCronAlert([
      { job: "a", label: "A", lastRanAt: "2026-09-28T09:00:00.000Z", hoursSilent: 40, reason: "silent" },
    ])!;
    const unfinished = staleCronAlert([
      { job: "b", label: "B", lastRanAt: "2026-09-30T05:00:00.000Z", hoursSilent: 5, reason: "not-completing" },
    ])!;
    expect(silent).toContain("not invoked");
    expect(unfinished).toContain("never finished");
  });
});
