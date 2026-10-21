import { describe, expect, it } from "vitest";
import { pragueDateOf, stayContinuedCleaningKeys, stayContinuedTaskIds, type ScheduleTaskRef } from "./stayLinkCleanings";

// Snapshot tasks as the cleaning app stores them: one per checkout.
// K.202 = 648596, K.203 = 648772.
const task = (bookId: number, roomId: string, arrival: string, departure: string): ScheduleTaskRef => ({
  id: `beds24-${bookId}`,
  bookId,
  roomId,
  date: departure,
  arrival,
  departure,
});

const PIOTR = [task(93901799, "648596", "2026-10-22", "2026-10-26"), task(93987993, "648596", "2026-10-26", "2026-10-27")];
const EARLY = [task(93890647, "648596", "2026-10-01", "2026-10-02"), task(93451409, "648596", "2026-10-02", "2026-10-04")];
const linkedOn = (prev: string, linkedAt: string) => ({ stayLink: { prev, linkedAt } });

describe("stayContinuedTaskIds", () => {
  it("skips the 26 Oct turnover between Piotr's Booking.com stay and his extension", () => {
    const ids = stayContinuedTaskIds(PIOTR, { "BH-93987993": linkedOn("BH-93901799", "2026-10-21T12:00:00Z") });
    expect([...ids]).toEqual(["beds24-93901799"]);
    expect([...stayContinuedCleaningKeys(PIOTR, { "BH-93987993": linkedOn("BH-93901799", "2026-10-21T12:00:00Z") })]).toEqual([
      "2026-10-26|648596",
    ]);
  });

  it("works the same for an early arrival booked before the main stay", () => {
    const ids = stayContinuedTaskIds(EARLY, { "BH-93451409": linkedOn("BH-93890647", "2026-09-29T08:00:00Z") });
    expect([...ids]).toEqual(["beds24-93890647"]);
  });

  it("never guesses: same names without a confirmed link keep the cleaning", () => {
    expect(stayContinuedTaskIds(PIOTR, {}).size).toBe(0);
    expect(stayContinuedTaskIds(PIOTR, null).size).toBe(0);
  });

  it("keeps the cleaning when the extension is in another apartment (guest moves)", () => {
    const moved = [PIOTR[0], { ...PIOTR[1], roomId: "648772" }];
    expect(stayContinuedTaskIds(moved, { "BH-93987993": linkedOn("BH-93901799", "2026-10-21T12:00:00Z") }).size).toBe(0);
  });

  it("keeps the cleaning when the two no longer meet", () => {
    const later = [PIOTR[0], { ...PIOTR[1], arrival: "2026-10-27", date: "2026-10-28", departure: "2026-10-28" }];
    expect(stayContinuedTaskIds(later, { "BH-93987993": linkedOn("BH-93901799", "2026-10-21T12:00:00Z") }).size).toBe(0);
  });

  it("doesn't rewrite history: a link made after the handover leaves that cleaning alone", () => {
    expect(stayContinuedTaskIds(PIOTR, { "BH-93987993": linkedOn("BH-93901799", "2026-10-27T09:00:00Z") }).size).toBe(0);
    // Made on the handover day itself (Prague): still in time.
    expect(stayContinuedTaskIds(PIOTR, { "BH-93987993": linkedOn("BH-93901799", "2026-10-26T06:00:00Z") }).size).toBe(1);
  });

  it("uses the Prague calendar day of the link", () => {
    // 23:30 UTC on the 25th is already the 26th in Prague.
    expect(pragueDateOf("2026-10-25T23:30:00Z")).toBe("2026-10-26");
    expect(pragueDateOf("nonsense")).toBeNull();
  });

  it("ignores mid-stay move cleanings", () => {
    const withMove = [...PIOTR, { id: "move-93901799-2026-10-26", bookId: 93901799, roomId: "648596", date: "2026-10-26", arrival: "2026-10-22", departure: "2026-10-26" }];
    const ids = stayContinuedTaskIds(withMove, { "BH-93987993": linkedOn("BH-93901799", "2026-10-21T12:00:00Z") });
    expect([...ids]).toEqual(["beds24-93901799"]);
  });

  it("follows a chain: every inner turnover goes, the final checkout stays", () => {
    const chain = [
      task(1, "679705", "2026-05-24", "2026-05-29"),
      task(2, "679705", "2026-05-29", "2026-06-06"),
      task(3, "679705", "2026-06-06", "2026-06-13"),
    ];
    const ids = stayContinuedTaskIds(chain, {
      "BH-2": linkedOn("BH-1", "2026-05-20T10:00:00Z"),
      "BH-3": linkedOn("BH-2", "2026-05-20T10:00:00Z"),
    });
    expect([...ids].sort()).toEqual(["beds24-1", "beds24-2"]);
  });
});
