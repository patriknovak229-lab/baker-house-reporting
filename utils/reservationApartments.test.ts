import { describe, it, expect } from "vitest";
import {
  reservationApartments,
  isMultiApartment,
  cleaningFeedNumbers,
  taskTargets,
  apartmentRoom,
} from "./reservationApartments";

const trio = {
  reservationNumber: "BH-93698209",
  room: "K.102 + O.308 + K.103",
  linkedRooms: ["K.102", "O.308", "K.103"],
  apartmentReservationNumbers: ["BH-93698209", "BH-93698210", "BH-93698211"],
};
const single = { reservationNumber: "BH-1", room: "K.201" };

describe("reservationApartments", () => {
  it("pairs each apartment's booking with its room", () => {
    expect(reservationApartments(trio)).toEqual([
      { reservationNumber: "BH-93698209", room: "K.102" },
      { reservationNumber: "BH-93698210", room: "O.308" },
      { reservationNumber: "BH-93698211", room: "K.103" },
    ]);
    expect(isMultiApartment(trio)).toBe(true);
  });

  it("treats a plain booking as one apartment under its own number", () => {
    expect(reservationApartments(single)).toEqual([{ reservationNumber: "BH-1", room: "K.201" }]);
    expect(isMultiApartment(single)).toBe(false);
  });

  it("falls back to the reservation when the lists don't line up", () => {
    expect(reservationApartments({ ...trio, apartmentReservationNumbers: ["BH-93698209"] })).toHaveLength(1);
  });
});

describe("cleaningFeedNumbers", () => {
  it("covers the reservation and every apartment, once each", () => {
    expect(cleaningFeedNumbers(trio)).toEqual(["BH-93698209", "BH-93698210", "BH-93698211"]);
    expect(cleaningFeedNumbers(single)).toEqual(["BH-1"]);
    expect(
      cleaningFeedNumbers({ reservationNumber: "BH-500", apartmentReservationNumbers: ["BH-501"] }),
    ).toEqual(["BH-500", "BH-501"]);
  });
});

describe("taskTargets", () => {
  it("is the picked apartment, else every apartment", () => {
    expect(taskTargets(trio, { apartment: "BH-93698210" })).toEqual(["BH-93698210"]);
    expect(taskTargets(trio, {})).toEqual(["BH-93698209", "BH-93698210", "BH-93698211"]);
    expect(taskTargets(single, {})).toEqual(["BH-1"]);
  });
});

describe("apartmentRoom", () => {
  it("names the room an apartment is in now", () => {
    expect(apartmentRoom(trio, "BH-93698211")).toBe("K.103");
    expect(apartmentRoom(trio, undefined)).toBeNull();
    expect(apartmentRoom(trio, "BH-999")).toBeNull();
  });
});
