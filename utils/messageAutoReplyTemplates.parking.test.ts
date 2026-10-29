import { describe, expect, it } from "vitest";
import type { Reservation } from "@/types/reservation";
import { buildTemplate } from "./messageAutoReplyTemplates";
import { computeParking } from "./parkingUtils";

function res(over: Partial<Reservation>): Reservation {
  return {
    reservationNumber: "BH-1",
    firstName: "Guest",
    lastName: "A",
    room: "K.102",
    checkInDate: "2026-10-30",
    checkOutDate: "2026-11-06",
    paymentStatus: "Paid",
    ...over,
  } as Reservation;
}

describe("parking auto-reply template", () => {
  const trio = res({ reservationNumber: "BH-93698209", room: "K.102", linkedRooms: ["O.308", "K.103"] });

  it("names every space of a multi-apartment booking", () => {
    const built = buildTemplate("parking", trio, computeParking([trio]), "general")!;
    expect(built.substitutions).toMatchObject({ COUNT: "3", SPACES: "15, 152 and 16" });
  });

  it("does not refuse a second car to a guest with several apartments", () => {
    const built = buildTemplate("parking", trio, computeParking([trio]), "multiple")!;
    expect(built.template).not.toContain("unable to offer a second one");
    expect(built.substitutions.SPACES).toBe("15, 152 and 16");
  });

  it("still refuses a second space for a single apartment", () => {
    const single = res({});
    const built = buildTemplate("parking", single, computeParking([single]), "multiple")!;
    expect(built.template).toContain("unable to offer a second one");
  });
});
