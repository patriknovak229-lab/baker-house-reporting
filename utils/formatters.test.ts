import { describe, it, expect } from "vitest";
import { formatCurrency, formatCurrencyExact } from "./formatters";

/** cs-CZ groups thousands with a narrow no-break space, not a plain space. */
const nbsp = (s: string) => s.replace(/ | /g, " ");

describe("formatCurrencyExact", () => {
  it("prints haléře, so the invoice matches the bank line", () => {
    // The complaint this exists for: charged 3 687,67, invoiced 3 688.
    expect(nbsp(formatCurrencyExact(3687.67))).toBe("3 687,67 Kč");
    expect(nbsp(formatCurrency(3687.67))).toBe("3 688 Kč");
  });

  it("always shows two decimals, even on a round amount", () => {
    expect(nbsp(formatCurrencyExact(27000))).toBe("27 000,00 Kč");
    expect(nbsp(formatCurrencyExact(27521.6))).toBe("27 521,60 Kč");
  });

  it("uses the Czech comma decimal separator", () => {
    expect(formatCurrencyExact(0.5)).toContain(",50");
    expect(formatCurrencyExact(1234.5)).not.toContain(".");
  });

  it("handles zero and negative amounts", () => {
    expect(nbsp(formatCurrencyExact(0))).toBe("0,00 Kč");
    expect(nbsp(formatCurrencyExact(-250.25))).toBe("-250,25 Kč");
  });

  it("leaves formatCurrency alone — the dashboard still rounds", () => {
    expect(nbsp(formatCurrency(27521.6))).toBe("27 522 Kč");
  });
});
