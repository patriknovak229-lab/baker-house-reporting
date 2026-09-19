import { describe, it, expect } from "vitest";
import { deriveIcoFromDic, missingInvoiceFields } from "./invoiceUtils";

// The billing-identity rule decides when the chat agent stops asking the guest,
// writes the details onto the reservation and lets the 09:00 cron mail the
// invoice — so the foreign-company cases below are the ones that used to strand
// a request in awaiting-info forever.

describe("deriveIcoFromDic", () => {
  it("recovers the IČO from a Czech or Slovak company DIČ", () => {
    expect(deriveIcoFromDic("CZ19876107")).toBe("19876107");
    expect(deriveIcoFromDic("SK12345678")).toBe("12345678");
    expect(deriveIcoFromDic("cz19876107")).toBe("19876107");
    expect(deriveIcoFromDic("CZ 198 761 07")).toBe("19876107");
  });

  it("never invents an IČO from a foreign VAT number", () => {
    expect(deriveIcoFromDic("PL5251985295")).toBeNull();
    expect(deriveIcoFromDic("DE366335248")).toBeNull();
    expect(deriveIcoFromDic("ATU12345678")).toBeNull();
  });

  it("rejects a Czech personal tax ID (birth number, not an IČO)", () => {
    expect(deriveIcoFromDic("CZ8809055464")).toBeNull();
  });

  it("handles absent input", () => {
    expect(deriveIcoFromDic(null)).toBeNull();
    expect(deriveIcoFromDic(undefined)).toBeNull();
    expect(deriveIcoFromDic("")).toBeNull();
  });
});

describe("missingInvoiceFields", () => {
  const complete = {
    companyName: "Acme s.r.o.",
    ico: "19876107",
    dic: "CZ19876107",
    email: "fakturace@acme.cz",
  };

  it("is satisfied by a Czech company with an IČO", () => {
    expect(missingInvoiceFields(complete)).toEqual([]);
  });

  it("accepts a foreign company that has a VAT number but no IČO", () => {
    // The real BH-93351977 case: Polish company, PL VAT, real email, no IČO.
    expect(
      missingInvoiceFields({
        companyName: "Akzo Nobel Car Refinishes Polska Sp. z o.o.",
        ico: null,
        dic: "PL5251985295",
        email: "buyer@example.com",
      }),
    ).toEqual([]);
  });

  it("accepts an IČO with no DIČ (company not VAT-registered)", () => {
    expect(missingInvoiceFields({ ...complete, dic: null })).toEqual([]);
  });

  it("flags a missing identifier when neither IČO nor VAT is known", () => {
    expect(missingInvoiceFields({ ...complete, ico: null, dic: null })).toEqual(["companyId"]);
  });

  it("flags company name and email independently", () => {
    expect(missingInvoiceFields({ ...complete, companyName: null })).toEqual(["companyName"]);
    expect(missingInvoiceFields({ ...complete, email: null })).toEqual(["email"]);
  });

  it("reports every gap at once, in ask order", () => {
    expect(
      missingInvoiceFields({ companyName: null, ico: null, dic: null, email: null }),
    ).toEqual(["companyName", "companyId", "email"]);
  });

  it("never treats companyAddress as mandatory", () => {
    // Address isn't even part of the rule's input — asserted here so a future
    // change that adds it has to come past this test.
    expect(missingInvoiceFields({ ...complete })).toEqual([]);
  });
});
