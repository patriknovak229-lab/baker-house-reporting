/**
 * Guest contact details after Booking.com stopped sending phone numbers
 * (2026-09-29 — the field arrives empty in Beds24 for every new booking).
 *
 * Right after a booking, a Beds24 auto action asks the guest in the channel
 * chat (Booking.com: phone + "coming by car?", Airbnb: car only — Airbnb still
 * sends the phone). The app listens for the reply, saves what it can (see
 * utils/guestContactService), and sends ONE follow-up when the answer is still
 * missing. Scheduled messages live in Beds24; follow-ups that depend on the
 * reply live here.
 *
 * Everything in this file is pure: question detection, reminder timing, the
 * reminder / thank-you wording in the seven languages the auto actions use.
 * The wording mirrors the approved auto-action text — change both together.
 */

import { formatPhoneDisplay } from '@/utils/stringUtils';

// ─── Detecting our question in a Beds24 thread ────────────────────────────────

/**
 * The car question + its yes/no hint, as it appears in every language version
 * of both auto actions (and in our own reminder). Compared with ALL whitespace
 * removed, so line breaks or double spaces don't matter. Deliberately includes
 * the "(yes / no)" part: the bare phrase also occurs in the pre-arrival parking
 * message ("falls Sie mit dem Auto anreisen, ist Ihr Parkplatz…").
 */
const ASK_SIGNATURES = [
  'coming by car? (yes / no)',
  'autem? (ano / ne)',
  'auto an? (ja / nein)',
  'érkezik? (igen / nem)',
  'samochodem? (tak / nie)',
  'автомобиле? (да / нет)',
  'autom? (áno / nie)',
].map(squash);

function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

export function isContactAsk(text: string): boolean {
  const t = squash(text);
  return ASK_SIGNATURES.some((sig) => t.includes(sig));
}

export interface ThreadMessage {
  role: 'guest' | 'host';
  text: string;
  time: string; // ISO
  id?: number;
}

/** Time of the FIRST host message that asks our question, or null. */
export function findContactAsk(thread: ThreadMessage[]): string | null {
  const asks = thread
    .filter((m) => m.role === 'host' && isContactAsk(m.text))
    .map((m) => m.time)
    .filter((t) => Number.isFinite(Date.parse(t)))
    .sort();
  return asks[0] ?? null;
}

/** Guest messages sent after our question — the candidate answers. */
export function guestRepliesAfter(thread: ThreadMessage[], askedAt: string): ThreadMessage[] {
  const t0 = Date.parse(askedAt);
  return thread.filter((m) => m.role === 'guest' && Date.parse(m.time) > t0);
}

// ─── What's still missing ─────────────────────────────────────────────────────

export interface ContactState {
  /** Phone as Beds24 has it (empty for Booking.com since 2026-09-29). */
  beds24Phone: string;
  beds24Mobile?: string;
  /** Phone saved in the app (drawer pencil or a captured reply). */
  overridePhone?: string;
  parkingUse?: { status: string } | null;
  /** "none" = the operator set No parking — asking about a car is pointless. */
  parkingOverride?: string;
}

export function contactNeeds(s: ContactState): { phone: boolean; parking: boolean } {
  const hasPhone = Boolean(s.beds24Phone?.trim() || s.beds24Mobile?.trim() || s.overridePhone?.trim());
  return {
    phone: !hasPhone,
    parking: !s.parkingUse && s.parkingOverride !== 'none',
  };
}

// ─── Prague wall-clock helpers ────────────────────────────────────────────────

const PRAGUE = 'Europe/Prague';

function pragueParts(d: Date): { y: number; m: number; day: number; h: number; min: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PRAGUE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), day: get('day'), h: get('hour'), min: get('minute') };
}

/** The UTC instant of `hour`:00 Prague time on a YYYY-MM-DD date (DST-aware). */
export function pragueTime(date: string, hour: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hour));
  const p = pragueParts(guess);
  const shownAsUtc = Date.UTC(p.y, p.m - 1, p.day, p.h, p.min);
  return new Date(guess.getTime() - (shownAsUtc - guess.getTime()));
}

/** YYYY-MM-DD in Prague. */
export function pragueDate(d: Date): string {
  const p = pragueParts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Guest-facing messages only go out 09:00–20:00 Prague. */
export function isGuestMessagingHour(now: Date): boolean {
  const h = pragueParts(now).h;
  return h >= 9 && h < 20;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CHECK_IN_HOUR = 15;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Reminder timing ──────────────────────────────────────────────────────────

/**
 * When the one follow-up is due, by how far ahead the guest booked
 * (15.5 % of Booking.com guests book within 24 h of arrival, 27 % within 3 days):
 *   - booked > 3 days ahead  → 3 days before arrival (09:00), at least 24 h after the question
 *   - booked 6 h – 3 days    → 6 h after the question
 *   - booked < 6 h ahead     → none (the no-phone alert covers it)
 * Never at or after check-in. Quiet hours are the caller's job.
 */
export function reminderDueAt(args: { bookingTime: string; arrival: string; askedAt: string }): Date | null {
  const checkIn = pragueTime(args.arrival, CHECK_IN_HOUR).getTime();
  const booked = Date.parse(args.bookingTime);
  const asked = Date.parse(args.askedAt);
  if (!Number.isFinite(checkIn) || !Number.isFinite(booked) || !Number.isFinite(asked)) return null;

  const lead = checkIn - booked;
  let due: number;
  if (lead <= 6 * HOUR) return null;
  if (lead <= 3 * DAY) {
    due = asked + 6 * HOUR;
  } else {
    due = Math.max(pragueTime(addDays(args.arrival, -3), 9).getTime(), asked + DAY);
  }
  return due < checkIn ? new Date(due) : null;
}

/**
 * Telegram the ops group to fetch the number from the extranet: phone still
 * missing, arrival today or tomorrow (Prague), and the guest has had an hour
 * to answer. Guests already in the house are left out.
 */
export function noPhoneAlertDue(args: {
  arrival: string;
  departure: string;
  askedAt: string | null;
  now: Date;
}): boolean {
  const today = pragueDate(args.now);
  if (args.arrival < today || args.arrival > addDays(today, 1)) return false;
  if (args.departure <= today) return false;
  if (args.askedAt && args.now.getTime() < Date.parse(args.askedAt) + HOUR) return false;
  return true;
}

// ─── Normalisation ────────────────────────────────────────────────────────────

export function normalizePlate(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 40);
  return s || undefined;
}

// ─── Wording ──────────────────────────────────────────────────────────────────

export const CONTACT_LANGS = ['en', 'cs', 'de', 'hu', 'pl', 'ru', 'sk'] as const;
export type ContactLang = (typeof CONTACT_LANGS)[number];

/** Beds24 `lang` or a detected ISO 639-1 code → one of our seven; English otherwise. */
export function contactLang(code: string | null | undefined): ContactLang {
  const c = (code ?? '').trim().toLowerCase().slice(0, 2);
  if (c === 'cz') return 'cs';
  return (CONTACT_LANGS as readonly string[]).includes(c) ? (c as ContactLang) : 'en';
}

interface ReminderCopy {
  greeting: (name: string) => string;
  intro: string;
  phone: string;
  car: string;
  closing: string;
}

// Czech and Polish greet without the name: both need the vocative (Petr → Petře).
const REMINDER: Record<ContactLang, ReminderCopy> = {
  en: {
    greeting: (n) => (n ? `Hello ${n},` : 'Hello,'),
    intro: 'Just a quick reminder – to help us make your stay smooth, we need:',
    phone: 'Your phone number (with country code), so we can reliably reach you.',
    car: 'Are you coming by car? (yes / no) If yes, your license plate helps us keep things organized.',
    closing: 'A short reply is all we need. Thank you!',
  },
  cs: {
    greeting: () => 'Dobrý den,',
    intro: 'jen krátce připomínáme – aby Váš pobyt proběhl hladce, potřebujeme:',
    phone: 'Vaše telefonní číslo (s předvolbou země), abychom Vás mohli spolehlivě kontaktovat.',
    car: 'Přijedete autem? (ano / ne) Pokud ano, registrační značka nám pomůže udržet vše v pořádku.',
    closing: 'Stačí krátká odpověď. Děkujeme!',
  },
  de: {
    greeting: (n) => (n ? `Hallo ${n},` : 'Guten Tag,'),
    intro: 'nur eine kurze Erinnerung – damit Ihr Aufenthalt reibungslos verläuft, benötigen wir:',
    phone: 'Ihre Telefonnummer (mit Ländervorwahl), damit wir Sie zuverlässig erreichen können.',
    car: 'Reisen Sie mit dem Auto an? (ja / nein) Falls ja, hilft uns Ihr Kennzeichen, alles gut zu organisieren.',
    closing: 'Eine kurze Antwort genügt. Vielen Dank!',
  },
  hu: {
    greeting: (n) => (n ? `Kedves ${n}!` : 'Kedves Vendégünk!'),
    intro: 'Csak egy rövid emlékeztető – hogy tartózkodása zökkenőmentes legyen, a következőkre van szükségünk:',
    phone: 'Telefonszáma (országhívószámmal), hogy megbízhatóan elérhessük.',
    car: 'Autóval érkezik? (igen / nem) Ha igen, a rendszám segít mindent rendben tartani.',
    closing: 'Elég egy rövid válasz. Köszönjük!',
  },
  pl: {
    greeting: () => 'Dzień dobry,',
    intro: 'krótko przypominamy – aby Państwa pobyt przebiegł bezproblemowo, potrzebujemy:',
    phone: 'Numeru telefonu (z numerem kierunkowym kraju), abyśmy mieli z Państwem pewny kontakt.',
    car: 'Czy przyjadą Państwo samochodem? (tak / nie) Jeśli tak, numer rejestracyjny pomoże nam wszystko dobrze zorganizować.',
    closing: 'Wystarczy krótka odpowiedź. Dziękujemy!',
  },
  ru: {
    greeting: (n) => (n ? `Здравствуйте, ${n}!` : 'Здравствуйте!'),
    intro: 'Небольшое напоминание: чтобы Ваше пребывание прошло гладко, нам нужно:',
    phone: 'Ваш номер телефона (с кодом страны), чтобы мы всегда могли с Вами связаться.',
    car: 'Вы приедете на автомобиле? (да / нет) Если да, номер автомобиля поможет нам всё хорошо организовать.',
    closing: 'Достаточно короткого ответа. Спасибо!',
  },
  sk: {
    greeting: (n) => (n ? `Dobrý deň, ${n},` : 'Dobrý deň,'),
    intro: 'len krátko pripomíname – aby Váš pobyt prebehol hladko, potrebujeme:',
    phone: 'Vaše telefónne číslo (s predvoľbou krajiny), aby sme Vás mohli spoľahlivo kontaktovať.',
    car: 'Prídete autom? (áno / nie) Ak áno, evidenčné číslo vozidla nám pomôže udržať všetko v poriadku.',
    closing: 'Stačí krátka odpoveď. Ďakujeme!',
  },
};

/** The one follow-up, asking only for what's still missing. Null when nothing is. */
export function renderReminder(args: {
  lang: ContactLang;
  firstName: string;
  askPhone: boolean;
  askCar: boolean;
}): string | null {
  const c = REMINDER[args.lang];
  const items = [args.askPhone ? c.phone : null, args.askCar ? c.car : null].filter(
    (x): x is string => x !== null,
  );
  if (items.length === 0) return null;
  const list = items.length === 1 ? items[0] : items.map((it, i) => `${i + 1}. ${it}`).join('\n');
  return [c.greeting(args.firstName.trim()), '', c.intro, '', list, '', c.closing, '', 'Baker House Apartments'].join('\n');
}

const THANKS: Record<ContactLang, { head: string; phone: string; car: string; noCar: string; yes: string }> = {
  en: { head: 'Thank you, noted:', phone: 'Phone', car: 'Car', noCar: 'no car', yes: 'yes' },
  cs: { head: 'Děkujeme, poznamenali jsme si:', phone: 'Telefon', car: 'Auto', noCar: 'bez auta', yes: 'ano' },
  de: { head: 'Vielen Dank, notiert:', phone: 'Telefon', car: 'Auto', noCar: 'kein Auto', yes: 'ja' },
  hu: { head: 'Köszönjük, feljegyeztük:', phone: 'Telefon', car: 'Autó', noCar: 'nincs autó', yes: 'igen' },
  pl: { head: 'Dziękujemy, zanotowaliśmy:', phone: 'Telefon', car: 'Samochód', noCar: 'bez samochodu', yes: 'tak' },
  ru: { head: 'Спасибо, мы записали:', phone: 'Телефон', car: 'Автомобиль', noCar: 'без автомобиля', yes: 'да' },
  sk: { head: 'Ďakujeme, poznačili sme si:', phone: 'Telefón', car: 'Auto', noCar: 'bez auta', yes: 'áno' },
};

/** Short confirmation echoing back what was saved, so the guest can spot a typo. */
export function renderThanks(args: {
  lang: ContactLang;
  phone?: string;
  parking?: { status: 'car' | 'no-car'; plate?: string };
}): string | null {
  const c = THANKS[args.lang];
  const lines: string[] = [];
  if (args.phone) lines.push(`${c.phone}: ${formatPhoneDisplay(args.phone)}`);
  if (args.parking) {
    const value = args.parking.status === 'no-car' ? c.noCar : (args.parking.plate ?? c.yes);
    lines.push(`${c.car}: ${value}`);
  }
  if (lines.length === 0) return null;
  return [c.head, ...lines].join('\n');
}
