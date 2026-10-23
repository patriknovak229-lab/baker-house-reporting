import { describe, it, expect } from "vitest";
import {
  contactLang,
  contactNeeds,
  findContactAsk,
  guestRepliesAfter,
  isContactAsk,
  isGuestMessagingHour,
  noPhoneAlertDue,
  normalizePlate,
  pragueTime,
  reminderDueAt,
  renderReminder,
  renderThanks,
  CONTACT_LANGS,
} from "./guestContact";

// The approved auto-action texts (Booking.com version) — detection must match all seven.
const ASKS = {
  en: "Hello Max,\n\nTo help us make your stay smooth, we need:\n\n1. Your phone number (with country code), so we can reliably reach you.\n2. Are you coming by car? (yes / no) If yes, your license plate helps us keep things organized.",
  cs: "Dobrý den,\n\naby Váš pobyt proběhl hladce, potřebujeme:\n\n2. Přijedete autem? (ano / ne) Pokud ano, registrační značka nám pomůže udržet vše v pořádku.",
  de: "Hallo Max,\n\n2. Reisen Sie mit dem Auto an? (ja / nein) Falls ja, hilft uns Ihr Kennzeichen, alles gut zu organisieren.",
  hu: "Kedves Max!\n\n2. Autóval érkezik? (igen / nem) Ha igen, a rendszám segít mindent rendben tartani.",
  pl: "Dzień dobry,\n\n2. Czy przyjadą Państwo samochodem? (tak / nie) Jeśli tak, numer rejestracyjny pomoże nam wszystko dobrze zorganizować.",
  ru: "Здравствуйте, Max!\n\n2. Вы приедете на автомобиле? (да / нет) Если да, номер автомобиля поможет нам всё хорошо организовать.",
  sk: "Dobrý deň, Max,\n\n2. Prídete autom? (áno / nie) Ak áno, evidenčné číslo vozidla nám pomôže udržať všetko v poriadku.",
};

describe("isContactAsk", () => {
  it("recognises every language version of the auto action", () => {
    for (const text of Object.values(ASKS)) expect(isContactAsk(text)).toBe(true);
  });

  it("recognises the Airbnb one-liner and survives reflowed whitespace", () => {
    expect(isContactAsk("To help us make your stay smooth: are you coming by car? (yes / no)\nIf yes…")).toBe(true);
    expect(isContactAsk("are you coming by car?\n(yes /\nno)")).toBe(true);
  });

  it("ignores the pre-arrival parking message that merely mentions arriving by car", () => {
    // A real pre-arrival message — it matched a looser signature during development.
    expect(
      isContactAsk("Hallo Max,\n\nfalls Sie mit dem Auto anreisen, ist Ihr reservierter Parkplatz Nummer 152."),
    ).toBe(false);
  });

  it("recognises our own reminder, so a reminder never looks like a missing question", () => {
    for (const lang of CONTACT_LANGS) {
      const text = renderReminder({ lang, firstName: "Max", askPhone: false, askCar: true })!;
      expect(isContactAsk(text)).toBe(true);
    }
  });
});

describe("findContactAsk / guestRepliesAfter", () => {
  const thread = [
    { role: "host" as const, text: "Your reservation is confirmed.", time: "2026-10-23T10:00:00Z" },
    { role: "guest" as const, text: "Hi, early check-in possible?", time: "2026-10-23T10:01:00Z" },
    { role: "host" as const, text: ASKS.en, time: "2026-10-23T10:02:00Z" },
    { role: "guest" as const, text: "+49 151 2345678, no car", time: "2026-10-23T11:00:00Z" },
    { role: "host" as const, text: ASKS.en, time: "2026-10-25T09:00:00Z" },
  ];

  it("returns the first ask and only the guest messages after it", () => {
    const askedAt = findContactAsk(thread);
    expect(askedAt).toBe("2026-10-23T10:02:00Z");
    expect(guestRepliesAfter(thread, askedAt!).map((m) => m.text)).toEqual(["+49 151 2345678, no car"]);
  });

  it("is null when we never asked", () => {
    expect(findContactAsk(thread.slice(0, 2))).toBeNull();
  });
});

describe("contactNeeds", () => {
  it("Booking.com booking with nothing yet needs both", () => {
    expect(contactNeeds({ beds24Phone: "" })).toEqual({ phone: true, parking: true });
  });

  it("a phone from Beds24, the mobile field or the drawer all count", () => {
    expect(contactNeeds({ beds24Phone: "+43 1" }).phone).toBe(false);
    expect(contactNeeds({ beds24Phone: "", beds24Mobile: "+43 1" }).phone).toBe(false);
    expect(contactNeeds({ beds24Phone: " ", overridePhone: "+420 1" }).phone).toBe(false);
  });

  it("an answer — or the operator's No parking — settles the car question", () => {
    expect(contactNeeds({ beds24Phone: "", parkingUse: { status: "no-car" } }).parking).toBe(false);
    expect(contactNeeds({ beds24Phone: "", parkingOverride: "none" }).parking).toBe(false);
  });
});

describe("pragueTime", () => {
  it("is DST-aware", () => {
    expect(pragueTime("2026-07-15", 15).toISOString()).toBe("2026-07-15T13:00:00.000Z");
    expect(pragueTime("2026-12-15", 15).toISOString()).toBe("2026-12-15T14:00:00.000Z");
  });
});

describe("reminderDueAt", () => {
  it("booked weeks ahead → 09:00 Prague three days before arrival", () => {
    const due = reminderDueAt({
      bookingTime: "2026-10-23T10:00:00Z",
      arrival: "2026-11-20",
      askedAt: "2026-10-23T10:02:00Z",
    });
    expect(due?.toISOString()).toBe("2026-11-17T08:00:00.000Z");
  });

  it("booked four days ahead → still at least 24 h after the question", () => {
    const due = reminderDueAt({
      bookingTime: "2026-11-16T07:00:00Z",
      arrival: "2026-11-20",
      askedAt: "2026-11-17T07:30:00Z",
    });
    expect(due?.toISOString()).toBe("2026-11-18T07:30:00.000Z");
  });

  it("booked a day ahead → six hours after the question", () => {
    const due = reminderDueAt({
      bookingTime: "2026-11-19T08:00:00Z",
      arrival: "2026-11-20",
      askedAt: "2026-11-19T08:01:00Z",
    });
    expect(due?.toISOString()).toBe("2026-11-19T14:01:00.000Z");
  });

  it("booked for tonight → no reminder", () => {
    expect(
      reminderDueAt({ bookingTime: "2026-11-20T10:00:00Z", arrival: "2026-11-20", askedAt: "2026-11-20T10:01:00Z" }),
    ).toBeNull();
  });

  it("never at or after check-in", () => {
    // Booked 7 h before check-in → due 6 h after the question = after 15:00.
    expect(
      reminderDueAt({ bookingTime: "2026-11-20T07:00:00Z", arrival: "2026-11-20", askedAt: "2026-11-20T08:30:00Z" }),
    ).toBeNull();
  });
});

describe("isGuestMessagingHour", () => {
  it("09:00–20:00 Prague only", () => {
    expect(isGuestMessagingHour(new Date("2026-11-17T07:59:00Z"))).toBe(false); // 08:59
    expect(isGuestMessagingHour(new Date("2026-11-17T08:00:00Z"))).toBe(true); // 09:00
    expect(isGuestMessagingHour(new Date("2026-11-17T18:59:00Z"))).toBe(true); // 19:59
    expect(isGuestMessagingHour(new Date("2026-11-17T19:00:00Z"))).toBe(false); // 20:00
  });
});

describe("noPhoneAlertDue", () => {
  const now = new Date("2026-11-19T10:00:00Z");
  it("arriving today or tomorrow", () => {
    expect(noPhoneAlertDue({ arrival: "2026-11-20", departure: "2026-11-22", askedAt: null, now })).toBe(true);
    expect(noPhoneAlertDue({ arrival: "2026-11-21", departure: "2026-11-22", askedAt: null, now })).toBe(false);
  });

  it("gives a fresh question an hour first", () => {
    expect(
      noPhoneAlertDue({ arrival: "2026-11-19", departure: "2026-11-20", askedAt: "2026-11-19T09:30:00Z", now }),
    ).toBe(false);
    expect(
      noPhoneAlertDue({ arrival: "2026-11-19", departure: "2026-11-20", askedAt: "2026-11-19T08:30:00Z", now }),
    ).toBe(true);
  });

  it("not for guests already staying, nor once the stay has ended", () => {
    expect(noPhoneAlertDue({ arrival: "2026-11-18", departure: "2026-11-21", askedAt: null, now })).toBe(false);
    expect(noPhoneAlertDue({ arrival: "2026-11-17", departure: "2026-11-19", askedAt: null, now })).toBe(false);
  });
});

describe("wording", () => {
  it("maps languages, defaulting to English", () => {
    expect(contactLang("cs")).toBe("cs");
    expect(contactLang("CZ")).toBe("cs");
    expect(contactLang("de-AT")).toBe("de");
    expect(contactLang("fr")).toBe("en");
    expect(contactLang(undefined)).toBe("en");
  });

  it("asks only for what's missing, numbering only when there are two", () => {
    const both = renderReminder({ lang: "en", firstName: "Max", askPhone: true, askCar: true })!;
    expect(both).toContain("1. Your phone number");
    expect(both).toContain("2. Are you coming by car?");
    const one = renderReminder({ lang: "en", firstName: "Max", askPhone: true, askCar: false })!;
    expect(one).toContain("\nYour phone number");
    expect(one).not.toContain("coming by car");
    expect(renderReminder({ lang: "en", firstName: "", askPhone: false, askCar: false })).toBeNull();
  });

  it("Czech and Polish greet without the name (no vocative in a template)", () => {
    expect(renderReminder({ lang: "cs", firstName: "Petr", askPhone: true, askCar: false })).toMatch(/^Dobrý den,\n/);
    expect(renderReminder({ lang: "pl", firstName: "Piotr", askPhone: true, askCar: false })).toMatch(/^Dzień dobry,\n/);
    expect(renderReminder({ lang: "de", firstName: "Max", askPhone: true, askCar: false })).toMatch(/^Hallo Max,\n/);
  });

  it("thank-you echoes back what was saved", () => {
    expect(renderThanks({ lang: "en", phone: "+4915123456789", parking: { status: "car", plate: "M-AB 123" } })).toBe(
      "Thank you, noted:\nPhone: +49 1512 3456 789\nCar: M-AB 123",
    );
    expect(renderThanks({ lang: "cs", parking: { status: "no-car" } })).toBe("Děkujeme, poznamenali jsme si:\nAuto: bez auta");
    expect(renderThanks({ lang: "de", parking: { status: "car" } })).toBe("Vielen Dank, notiert:\nAuto: ja");
    expect(renderThanks({ lang: "en" })).toBeNull();
  });

  it("normalises plates", () => {
    expect(normalizePlate("  m-ab   123 ")).toBe("M-AB 123");
    expect(normalizePlate("")).toBeUndefined();
    expect(normalizePlate(null)).toBeUndefined();
  });
});
