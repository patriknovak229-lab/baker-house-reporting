import { describe, expect, it } from "vitest";
import type { StayLink } from "@/types/reservation";
import {
  confirmedLinks,
  phoneKeyOf,
  sameStayKeys,
  stayChainIndex,
  stayChains,
  staySuggestions,
  type SuggestRef,
} from "./stayChains";

const link = (prev: string, linkedAt = "2026-10-21T10:00:00Z"): StayLink => ({
  prev,
  source: "manual",
  linkedAt,
  linkedBy: "op@example.com",
});

// Shaped on real bookings (Oct 2026), contact details made up. Piotr's Booking.com stay + the
// one-night direct extension; another guest checks out of O.308 the same day.
const PIOTR: SuggestRef[] = [
  { reservationNumber: "BH-93901799", checkInDate: "2026-10-22", checkOutDate: "2026-10-26", firstName: "Piotr", lastName: "Marczewski", email: "guest1.100001@guest.booking.com", phone: "" },
  { reservationNumber: "BH-93987993", checkInDate: "2026-10-26", checkOutDate: "2026-10-27", firstName: "Piotr", lastName: "Marczewski", email: "", phone: "+48 700 100 200" },
  { reservationNumber: "BH-94881179", checkInDate: "2026-10-23", checkOutDate: "2026-10-26", firstName: "Jonas", lastName: "Other", email: "guest2.100002@guest.booking.com", phone: "" },
];

// Early arrival: the direct booking covers the night BEFORE the Booking.com stay.
const EARLY: SuggestRef[] = [
  { reservationNumber: "BH-93890647", checkInDate: "2026-10-01", checkOutDate: "2026-10-02", firstName: "Dana", lastName: "Rybová", email: "dana.example@example.com", phone: "+48500111222" },
  { reservationNumber: "BH-93451409", checkInDate: "2026-10-02", checkOutDate: "2026-10-04", firstName: "Dana", lastName: "Rybová", email: "guest3.100003@guest.booking.com", phone: "+48 500 111 222" },
];

// Four Booking.com bookings in a row, each with its own relay address.
const FOUR: SuggestRef[] = [
  { reservationNumber: "BH-87127096", checkInDate: "2026-05-24", checkOutDate: "2026-05-29", firstName: "Lukáš", lastName: "Horák", email: "guest4.1@guest.booking.com", phone: "+420 700 000 108" },
  { reservationNumber: "BH-87335189", checkInDate: "2026-05-29", checkOutDate: "2026-06-06", firstName: "Lukáš", lastName: "Horák", email: "guest4.2@guest.booking.com", phone: "+420 700 000 108" },
  { reservationNumber: "BH-87574083", checkInDate: "2026-06-06", checkOutDate: "2026-06-13", firstName: "Lukáš", lastName: "Horák", email: "guest4.3@guest.booking.com", phone: "+420 700 000 108" },
  { reservationNumber: "BH-88107336", checkInDate: "2026-06-13", checkOutDate: "2026-06-19", firstName: "Lukáš", lastName: "Horák", email: "guest4.4@guest.booking.com", phone: "+420 700 000 108" },
];

describe("confirmed links → stays", () => {
  it("joins an OTA stay and its direct extension", () => {
    const all = [PIOTR[0], { ...PIOTR[1], stayLink: link("BH-93901799") }, PIOTR[2]];
    const chains = stayChains(all);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ checkInDate: "2026-10-22", checkOutDate: "2026-10-27", nights: 5 });
    expect(chains[0].members.map((m) => m.reservationNumber)).toEqual(["BH-93901799", "BH-93987993"]);
  });

  it("joins an early-arrival booking that comes BEFORE the main stay", () => {
    const all = [EARLY[0], { ...EARLY[1], stayLink: link("BH-93890647") }];
    const index = stayChainIndex(all);
    expect(index.get("BH-93890647")?.members.map((m) => m.reservationNumber)).toEqual(["BH-93890647", "BH-93451409"]);
    expect(index.get("BH-93451409")).toBe(index.get("BH-93890647"));
    expect(index.get("BH-93451409")?.nights).toBe(3);
  });

  it("follows a chain of four bookings, whatever order they arrive in", () => {
    const linked = FOUR.map((r, i) => (i === 0 ? r : { ...r, stayLink: link(FOUR[i - 1].reservationNumber) }));
    const chains = stayChains([...linked].reverse());
    expect(chains).toHaveLength(1);
    expect(chains[0].members.map((m) => m.reservationNumber)).toEqual(FOUR.map((r) => r.reservationNumber));
    expect(chains[0]).toMatchObject({ checkInDate: "2026-05-24", checkOutDate: "2026-06-19", nights: 26 });
  });

  it("drops a link whose bookings no longer meet (stay shortened / moved)", () => {
    const shortened = { ...PIOTR[0], checkOutDate: "2026-10-25" };
    expect(stayChains([shortened, { ...PIOTR[1], stayLink: link("BH-93901799") }])).toEqual([]);
  });

  it("drops a link when either side is cancelled or a blackout", () => {
    expect(stayChains([{ ...PIOTR[0], isCancelled: true }, { ...PIOTR[1], stayLink: link("BH-93901799") }])).toEqual([]);
    expect(stayChains([PIOTR[0], { ...PIOTR[1], isCancelled: true, stayLink: link("BH-93901799") }])).toEqual([]);
    expect(stayChains([{ ...PIOTR[0], isBlackout: true }, { ...PIOTR[1], stayLink: link("BH-93901799") }])).toEqual([]);
  });

  it("ignores a link to a booking that isn't there", () => {
    expect(confirmedLinks([{ ...PIOTR[1], stayLink: link("BH-1") }]).size).toBe(0);
  });

  it("lets only one booking continue a stay — the older link wins", () => {
    const rival = { ...PIOTR[1], reservationNumber: "BH-2", stayLink: link("BH-93901799", "2026-10-22T09:00:00Z") };
    const first = { ...PIOTR[1], stayLink: link("BH-93901799", "2026-10-21T09:00:00Z") };
    const links = confirmedLinks([PIOTR[0], rival, first]);
    expect([...links]).toEqual([["BH-93987993", "BH-93901799"]]);
  });
});

describe("suggestions", () => {
  const TODAY = "2026-10-21";

  it("suggests Piotr's extension by name — and NOT the O.308 guest who leaves the same day", () => {
    const s = staySuggestions(PIOTR, TODAY);
    expect(s.map((x) => [x.earlier.reservationNumber, x.later.reservationNumber, x.signals])).toEqual([
      ["BH-93901799", "BH-93987993", ["name"]],
    ]);
  });

  it("matches on phone across formats, and never on channel relay addresses", () => {
    const s = staySuggestions(EARLY, "2026-09-30");
    expect(s).toHaveLength(1);
    expect(s[0].signals).toEqual(["name", "phone"]);

    // Different names, same Booking.com relay domain: no signal at all.
    const relay = staySuggestions(
      [
        { reservationNumber: "A", checkInDate: "2026-10-22", checkOutDate: "2026-10-24", firstName: "Ann", lastName: "One", email: "x.1@guest.booking.com" },
        { reservationNumber: "B", checkInDate: "2026-10-24", checkOutDate: "2026-10-25", firstName: "Bob", lastName: "Two", email: "x.1@guest.booking.com" },
      ],
      TODAY,
    );
    expect(relay).toEqual([]);
  });

  it("catches a different-name extension booked under the same real email or phone", () => {
    const s = staySuggestions(
      [
        { reservationNumber: "A", checkInDate: "2026-10-22", checkOutDate: "2026-10-24", firstName: "Jan", lastName: "Novák", additionalEmail: "Jan.Novak@Firma.cz" },
        { reservationNumber: "B", checkInDate: "2026-10-24", checkOutDate: "2026-10-25", firstName: "Firma", lastName: "s.r.o.", email: "jan.novak@firma.cz " },
      ],
      TODAY,
    );
    expect(s.map((x) => x.signals)).toEqual([["email"]]);
  });

  it("only offers upcoming handovers (today counts)", () => {
    expect(staySuggestions(EARLY, "2026-10-03")).toEqual([]);
    expect(staySuggestions(EARLY, "2026-10-02")).toHaveLength(1);
  });

  it("skips pairs already linked or marked 'not the same guest'", () => {
    expect(staySuggestions([PIOTR[0], { ...PIOTR[1], stayLink: link("BH-93901799") }], TODAY)).toEqual([]);
    expect(staySuggestions([PIOTR[0], { ...PIOTR[1], stayLinkRejected: ["BH-93901799"] }], TODAY)).toEqual([]);
    expect(staySuggestions([{ ...PIOTR[0], stayLinkRejected: ["BH-93987993"] }, PIOTR[1]], TODAY)).toEqual([]);
  });

  it("doesn't offer a second continuation for a stay that already has one", () => {
    const other = { ...PIOTR[1], reservationNumber: "BH-3" };
    const s = staySuggestions([PIOTR[0], { ...PIOTR[1], stayLink: link("BH-93901799") }, other], TODAY);
    expect(s).toEqual([]);
  });

  it("ignores cancelled bookings and blackouts", () => {
    expect(staySuggestions([PIOTR[0], { ...PIOTR[1], isCancelled: true }], TODAY)).toEqual([]);
    expect(staySuggestions([{ ...PIOTR[0], isBlackout: true }, PIOTR[1]], TODAY)).toEqual([]);
  });

  it("normalises phones to their last 9 digits and rejects short ones", () => {
    expect(phoneKeyOf("+48 700 100 200")).toBe("700100200");
    expect(phoneKeyOf("00420 700-000-108")).toBe("700000108");
    expect(phoneKeyOf("12345")).toBeUndefined();
    expect(phoneKeyOf(undefined)).toBeUndefined();
  });
});

describe("sameStayKeys (room resolver identity)", () => {
  it("keys same-name back-to-back bookings together, as before", () => {
    const keys = sameStayKeys(PIOTR);
    expect(keys.get("BH-93901799")).toBeDefined();
    expect(keys.get("BH-93987993")).toBe(keys.get("BH-93901799"));
    expect(keys.get("BH-94881179")).toBeUndefined(); // continues nobody
  });

  it("an operator link joins different names", () => {
    const keys = sameStayKeys([
      PIOTR[0],
      { ...PIOTR[1], firstName: "Someone", lastName: "Else", stayLink: link("BH-93901799") },
    ]);
    expect(keys.get("BH-93987993")).toBe(keys.get("BH-93901799"));
  });

  it("'not the same guest' splits equal names", () => {
    const keys = sameStayKeys([PIOTR[0], { ...PIOTR[1], stayLinkRejected: ["BH-93901799"] }]);
    expect(keys.get("BH-93901799")).toBeUndefined();
    expect(keys.get("BH-93987993")).toBeUndefined();
  });

  it("one key for a whole chain", () => {
    const keys = sameStayKeys(FOUR);
    expect(new Set(FOUR.map((r) => keys.get(r.reservationNumber))).size).toBe(1);
  });
});
