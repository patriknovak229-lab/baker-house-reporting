import { describe, it, expect } from "vitest";
import {
  cleaningRequestsByBooking,
  buildCleaningRequestsMap,
  requestedManualCleanings,
} from "./cleaningRequestsPublish";
import { isMidStayDate, defaultMidStayDate } from "./midStayCleaning";
import type { Issue, IssueCategory } from "../types/reservation";

function issue(over: Partial<Issue> & { category?: IssueCategory } = {}): Issue {
  return {
    id: "c1",
    category: "cleaning",
    text: "",
    actionableDate: "2026-11-02",
    resolved: false,
    createdAt: "2026-10-30T10:00:00Z",
    ...over,
  };
}

// BH-93698209 shape: K.102 (master) + O.308 + K.103, 30 Oct → 6 Nov.
const trio = {
  reservationNumber: "BH-93698209",
  room: "K.102 + O.308 + K.103",
  linkedRooms: ["K.102", "O.308", "K.103"],
  apartmentReservationNumbers: ["BH-93698209", "BH-93698210", "BH-93698211"],
  checkInDate: "2026-10-30",
  checkOutDate: "2026-11-06",
};
const single = {
  reservationNumber: "BH-1",
  room: "K.201",
  checkInDate: "2026-10-30",
  checkOutDate: "2026-11-06",
};

describe("cleaningRequestsByBooking", () => {
  it("publishes a mid-stay cleaning in the reservation's room", () => {
    expect(cleaningRequestsByBooking(single, [issue({ text: "Výměna ručníků" })])).toEqual({
      "BH-1": [{ id: "c1", date: "2026-11-02", roomId: 656437, room: "K.201", text: "Výměna ručníků" }],
    });
  });

  it("puts a request for all apartments in every apartment, under each one's booking", () => {
    const out = cleaningRequestsByBooking(trio, [issue()]);
    expect(Object.keys(out)).toEqual(["BH-93698209", "BH-93698210", "BH-93698211"]);
    expect(out["BH-93698210"][0]).toMatchObject({ room: "O.308", roomId: 674672 });
  });

  it("puts a request for one apartment in that apartment only", () => {
    const out = cleaningRequestsByBooking(trio, [issue({ apartment: "BH-93698211" })]);
    expect(out).toEqual({
      "BH-93698211": [{ id: "c1", date: "2026-11-02", roomId: 679704, room: "K.103", text: "" }],
    });
  });

  it("keeps a resolved request — resolving clears the reminder, not the cleaning", () => {
    expect(cleaningRequestsByBooking(single, [issue({ resolved: true })])["BH-1"]).toHaveLength(1);
  });

  it("skips dates outside the stay — arrival and departure days have their own cleanings", () => {
    for (const actionableDate of ["2026-10-30", "2026-11-06", "2026-10-20", ""]) {
      expect(cleaningRequestsByBooking(single, [issue({ actionableDate })])).toEqual({});
    }
  });

  it("publishes only mid-stay cleaning requests", () => {
    for (const category of ["special", "facility", "earlyCheckin", "lateCheckout", "problem"] as IssueCategory[]) {
      expect(cleaningRequestsByBooking(single, [issue({ category })])).toEqual({});
    }
  });

  it("skips an apartment Beds24 hasn't placed in a unit yet", () => {
    const waiting = {
      ...trio,
      room: "O.308 + 1KK Urban Studios",
      linkedRooms: ["O.308", "1KK Urban Studios"],
      apartmentReservationNumbers: ["BH-95377263", "BH-95377264"],
      reservationNumber: "BH-95377263",
    };
    expect(Object.keys(cleaningRequestsByBooking(waiting, [issue()]))).toEqual(["BH-95377263"]);
  });
});

describe("buildCleaningRequestsMap", () => {
  it("only covers the reservations it's given — cancelled ones are left out by the caller", () => {
    const overrides = { "BH-1": { issues: [issue()] }, "BH-2": { issues: [issue({ id: "c2" })] } };
    expect(Object.keys(buildCleaningRequestsMap(overrides, [single]))).toEqual(["BH-1"]);
  });
});

describe("requestedManualCleanings", () => {
  const requests = {
    "BH-93698210": [{ id: "c1", date: "2026-11-02", roomId: 674672, room: "O.308", text: "Úklid" }],
  };

  it("turns a request into a manual-cleaning record tagged with its booking", () => {
    expect(requestedManualCleanings(requests, [])).toEqual([
      {
        id: "request-c1-674672",
        date: "2026-11-02",
        roomId: "674672",
        roomName: "O.308",
        reservationNumber: "BH-93698210",
        note: "Úklid",
      },
    ]);
  });

  it("yields to a manual cleaning the operator already added on that day and room", () => {
    expect(requestedManualCleanings(requests, [{ date: "2026-11-02", roomId: "674672" }])).toEqual([]);
  });

  it("handles no published requests", () => {
    expect(requestedManualCleanings(null, [])).toEqual([]);
  });
});

describe("mid-stay dates", () => {
  const stay = { checkInDate: "2026-10-30", checkOutDate: "2026-11-06" };
  it("accepts the nights after arrival, up to the last night", () => {
    expect(isMidStayDate(stay, "2026-10-31")).toBe(true);
    expect(isMidStayDate(stay, "2026-11-05")).toBe(true);
    expect(isMidStayDate(stay, "2026-10-30")).toBe(false);
    expect(isMidStayDate(stay, "2026-11-06")).toBe(false);
  });
  it("defaults to the middle night", () => {
    expect(defaultMidStayDate(stay)).toBe("2026-11-02");
    expect(isMidStayDate(stay, defaultMidStayDate(stay))).toBe(true);
    // A one-night stay has no mid-stay night; the drawer then blocks Add.
    expect(defaultMidStayDate({ checkInDate: "2026-10-30", checkOutDate: "2026-10-31" })).toBe("2026-10-30");
  });
});
