import { describe, expect, it } from "vitest";
import type { Reservation } from "@/types/reservation";
import { buildBookingBlock } from "./aiReplyComposer";

// The webhook's context shape: `room` = the booking the guest wrote on,
// `linkedRooms` = the guest's other apartments.
const reservation = {
  reservationNumber: "BH-93698209",
  firstName: "Guest",
  room: "K.102",
  linkedRooms: ["O.308", "K.103"],
  checkInDate: "2026-10-30",
  checkOutDate: "2026-11-06",
} as Reservation;

describe("buildBookingBlock — parking", () => {
  it("tells the model a three-apartment guest has three spaces, so a second car is fine (BH-93698209)", () => {
    const block = buildBookingBlock({
      guestMessage: "Good day, I need parking for 2 cars.",
      reservation,
      parkingSpaces: [
        { space: "15", type: "auto", room: "K.102" },
        { space: "152", type: "auto", room: "O.308" },
        { space: "16", type: "auto", room: "K.103" },
      ],
      history: [],
    });
    expect(block).toContain("Apartment(s): K.102, O.308, K.103");
    expect(block).toContain("3 parking spaces, one per apartment — K.102 → space 15, O.308 → space 152, K.103 → space 16");
    expect(block).toContain("up to 3 cars");
    expect(block).not.toContain("Assigned parking space:");
  });

  it("keeps the single-space line for a one-apartment stay", () => {
    const block = buildBookingBlock({
      guestMessage: "Where do I park?",
      reservation: { ...reservation, linkedRooms: undefined },
      parkingSpaces: [{ space: "15", type: "auto", room: "K.102" }],
      history: [],
    });
    expect(block).toContain("Assigned parking space: 15");
    expect(block).not.toContain("one per apartment");
  });
});
