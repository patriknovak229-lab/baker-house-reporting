import { describe, it, expect } from "vitest";
import { planSave } from "./guestContactService";
import { parseContact } from "./guestContactExtractor";

const NOW = new Date("2026-10-23T12:00:00Z");
const both = { phone: true, parking: true };

describe("parseContact", () => {
  it("reads the structured output, dropping blanks and junk", () => {
    expect(parseContact('{"phone":"+49 151 2345678","car":"no","plate":null,"onlyContactInfo":true}')).toEqual({
      phone: "+49 151 2345678",
      car: "no",
      plate: null,
      onlyContactInfo: true,
    });
    expect(parseContact('{"phone":"  ","car":"maybe","plate":"","onlyContactInfo":"yes"}')).toEqual({
      phone: null,
      car: null,
      plate: null,
      onlyContactInfo: false,
    });
    expect(parseContact("not json").phone).toBeNull();
  });
});

describe("planSave", () => {
  it("stores the phone as E.164 and the car answer as the guest's", () => {
    expect(
      planSave({ phone: "+49 151 2345678", car: "yes", plate: " m-ab 123 ", onlyContactInfo: true }, both, null, NOW),
    ).toEqual({
      phone: "+491512345678",
      parking: { status: "car", plate: "M-AB 123", source: "guest", updatedAt: NOW.toISOString() },
    });
  });

  it("a plate alone means they're coming by car; 'no' drops any plate", () => {
    expect(planSave({ phone: null, car: null, plate: "BA123XY", onlyContactInfo: true }, both, null, NOW).parking?.status).toBe("car");
    expect(planSave({ phone: null, car: "no", plate: "BA123XY", onlyContactInfo: true }, both, null, NOW).parking).toEqual({
      status: "no-car",
      source: "guest",
      updatedAt: NOW.toISOString(),
    });
  });

  it("never overwrites a phone on file, and skips an unusable one", () => {
    const answer = { phone: "+43 676 1234567", car: null, plate: null, onlyContactInfo: true };
    expect(planSave(answer, { phone: false, parking: true }, null, NOW).phone).toBeUndefined();
    expect(planSave({ ...answer, phone: "12" }, both, null, NOW).phone).toBeUndefined();
  });

  it("a guest may change their own answer, never the operator's", () => {
    const answer = { phone: null, car: "yes" as const, plate: null, onlyContactInfo: true };
    const fromGuest = { status: "no-car" as const, source: "guest" as const, updatedAt: "x" };
    const fromOperator = { status: "no-car" as const, source: "operator" as const, updatedAt: "x" };
    expect(planSave(answer, { phone: false, parking: false }, fromGuest, NOW).parking?.status).toBe("car");
    expect(planSave(answer, { phone: false, parking: false }, fromOperator, NOW).parking).toBeUndefined();
  });
});
