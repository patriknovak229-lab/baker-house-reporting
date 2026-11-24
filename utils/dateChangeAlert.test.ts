import { describe, it, expect } from "vitest";
import { clashesInRoom, dateChangeMessage, detectDateChange, type BookingLite } from "./dateChangeAlert";

// BH-95599985: the guest moved to Dec 12→14; Beds24 kept her in K.102 (679703),
// where Andreja already held Dec 13→15.
const before: BookingLite = { id: 95599985, roomId: 679703, arrival: "2026-12-05", departure: "2026-12-07", status: "new", firstName: "Silvia", lastName: "Ekres", apiSource: "Booking.com" };
const after: BookingLite = { ...before, arrival: "2026-12-12", departure: "2026-12-14" };
const cache: Record<string, BookingLite> = {
  "95599985": before,
  "96563820": { id: 96563820, roomId: 679703, arrival: "2026-12-13", departure: "2026-12-15", status: "new", firstName: "Andreja", lastName: "Belec Vrhovec" },
  "96160738": { id: 96160738, roomId: 679703, arrival: "2026-12-03", departure: "2026-12-12", status: "new", firstName: "Wouter", lastName: "van Maurik" }, // checks out as she arrives
  "95291645": { id: 95291645, roomId: 679703, arrival: "2026-12-12", departure: "2026-12-13", status: "cancelled", firstName: "Ghost", lastName: "Cancelled" },
  "70000001": { id: 70000001, roomId: 679703, arrival: "2026-12-12", departure: "2026-12-20", status: "black" },
  "95877031": { id: 95877031, roomId: 679705, arrival: "2026-12-06", departure: "2026-12-14", status: "new", firstName: "Other", lastName: "Unit" },
};

describe("detectDateChange", () => {
  it("reports old and new dates when they moved", () => {
    expect(detectDateChange(after, before)).toEqual({
      from: { arrival: "2026-12-05", departure: "2026-12-07" },
      to: { arrival: "2026-12-12", departure: "2026-12-14" },
    });
  });
  it("ignores any other modification, a booking we never cached, and cancellations", () => {
    expect(detectDateChange({ ...before, roomId: 679705 }, before)).toBeNull();
    expect(detectDateChange(after, undefined)).toBeNull();
    expect(detectDateChange({ ...after, status: "cancelled" }, before)).toBeNull();
  });
});

describe("clashesInRoom", () => {
  it("finds live bookings in the same unit on the new nights — not turnovers, cancellations, blackouts or other units", () => {
    expect(clashesInRoom(after, cache).map((b) => b.id)).toEqual([96563820]);
  });
});

describe("dateChangeMessage", () => {
  it("names the double-booking and points to the room-assignment fix", () => {
    const msg = dateChangeMessage(after, detectDateChange(after, before)!, "K.102", clashesInRoom(after, cache));
    expect(msg).toContain("Dates changed — K.102");
    expect(msg).toContain("05/12/2026 → 07/12/2026");
    expect(msg).toContain("<b>12/12/2026 → 14/12/2026</b>");
    expect(msg).toContain("double-booked in K.102 with Andreja Belec Vrhovec (13/12/2026 → 15/12/2026)");
    expect(msg).toContain("Room assignment needed");
  });
  it("says so when the unit is free", () => {
    expect(dateChangeMessage(after, detectDateChange(after, before)!, "K.102", [])).toContain("free for the new dates");
  });
  it("escapes guest-supplied text for Telegram's HTML mode", () => {
    const evil = { ...after, firstName: "<b>Bob</b>", lastName: "&Co" };
    expect(dateChangeMessage(evil, detectDateChange(evil, before)!, "K.102", [])).toContain("&lt;b&gt;Bob&lt;/b&gt; &amp;Co");
  });
});
