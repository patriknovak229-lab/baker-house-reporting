'use client';
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import type { Reservation, PaymentStatus, RatingStatus, InvoiceStatus, InvoiceData, CustomerFlag, Issue, IssueCategory } from "@/types/reservation";
import type { AdditionalPayment } from "@/types/additionalPayment";
import type { Voucher } from "@/types/voucher";
import type { SplitPayment } from "@/types/splitPayment";
import type { InvoiceRequest } from "@/types/invoiceRequest";
import type { EmailSendLogEntry } from "@/types/emailSendLog";
import type { UnreadBookingSummary } from "@/app/api/messages/unread/route";
import type { PendingDraft, PendingOther } from "@/app/api/webhook/beds24-message/route";
import FilterPanel, { defaultFilters } from "./FilterPanel";
import OccupancyCalendar from "./OccupancyCalendar";
import type { Filters } from "./FilterPanel";
import ReservationTable from "./ReservationTable";
import ReservationDrawer from "./ReservationDrawer";
import CreateBookingModal from "./CreateBookingModal";
import BlackoutModal from "./BlackoutModal";
import PaymentLinkModal from "./PaymentLinkModal";
import CreateVoucherModal from "./CreateVoucherModal";
import PriceCheckModal from "./PriceCheckModal";
import { getEffectiveFlags } from "@/utils/flagUtils";
import { normalizeForSearch } from "@/utils/stringUtils";
import { isRateTypeInScope, effectiveRateType } from "@/utils/rateType";
import { planForUnallocated } from "@/utils/roomAllocation";
import { ratingClass } from "@/utils/rating";
import { useSession } from "next-auth/react";
import { canMutate } from "@/utils/roles";
import type { Role } from "@/utils/roles";

// ─── Local state persistence (Redis-backed) ──────────────────────────────────
// Locally managed fields are not stored in Beds24. They are persisted in Redis
// via /api/local-state so they are shared across devices and browsers.

type LocalFields = {
  additionalEmail?: string;
  phone?: string;
  paymentStatusOverride?: PaymentStatus | null;
  notes?: string;
  manualFlagOverrides?: Partial<Record<CustomerFlag, boolean>>;
  ratingStatus?: RatingStatus;
  manualRating?: import('@/types/reservation').GuestRating | null;
  rateTypeOverride?: import('@/types/reservation').RateType | null;
  invoiceData?: InvoiceData | null;
  invoiceStatus?: InvoiceStatus;
  issues?: Issue[];
  parkingOverride?: string;
  invoiceModifications?: import('@/types/reservation').InvoiceModification[];
  postStayAcknowledgedAt?: string;
  postStaySnapshot?: import('@/types/reservation').BookingSnapshot;
};

function extractLocalFields(r: Reservation): LocalFields {
  const local: LocalFields = {};
  if (r.additionalEmail) local.additionalEmail = r.additionalEmail;
  if (r.phone) local.phone = r.phone;
  if (r.paymentStatusOverride !== null) local.paymentStatusOverride = r.paymentStatusOverride;
  if (r.notes) local.notes = r.notes;
  if (Object.keys(r.manualFlagOverrides).length > 0) local.manualFlagOverrides = r.manualFlagOverrides;
  if (r.ratingStatus !== "none") local.ratingStatus = r.ratingStatus;
  if (r.manualRating) local.manualRating = r.manualRating;
  if (r.rateTypeOverride != null) local.rateTypeOverride = r.rateTypeOverride;
  if (r.invoiceData) local.invoiceData = r.invoiceData;
  if (r.invoiceStatus !== "Not Issued") local.invoiceStatus = r.invoiceStatus;
  if (r.issues && r.issues.length > 0) local.issues = r.issues;
  if (r.parkingOverride !== undefined) local.parkingOverride = r.parkingOverride;
  if (r.invoiceModifications && r.invoiceModifications.length > 0) local.invoiceModifications = r.invoiceModifications;
  if (r.postStayAcknowledgedAt) local.postStayAcknowledgedAt = r.postStayAcknowledgedAt;
  if (r.postStaySnapshot) local.postStaySnapshot = r.postStaySnapshot;
  return local;
}

/**
 * Diff a reservation's CURRENT state against the snapshot captured at
 * the last acknowledgment. Returns a list of human-readable change
 * descriptions, or empty if no diff (or no snapshot to compare against).
 *
 * Only checks the fields stored in BookingSnapshot — these are what
 * operators typically care about when a channel re-import drifts a
 * past booking (dates, price, room, channel, guest count).
 */
function computePostStayDiff(r: Reservation): string[] {
  const snap = r.postStaySnapshot;
  if (!snap) return [];
  const diffs: string[] = [];
  if (snap.checkInDate !== r.checkInDate)     diffs.push(`Check-in: ${snap.checkInDate} → ${r.checkInDate}`);
  if (snap.checkOutDate !== r.checkOutDate)   diffs.push(`Check-out: ${snap.checkOutDate} → ${r.checkOutDate}`);
  if (snap.numberOfNights !== r.numberOfNights) diffs.push(`Nights: ${snap.numberOfNights} → ${r.numberOfNights}`);
  if (snap.numberOfGuests !== r.numberOfGuests) diffs.push(`Guests: ${snap.numberOfGuests} → ${r.numberOfGuests}`);
  if (Math.round(snap.price) !== Math.round(r.price)) {
    diffs.push(`Price: ${snap.price.toLocaleString('cs-CZ')} → ${r.price.toLocaleString('cs-CZ')} Kč`);
  }
  if (snap.room !== r.room)         diffs.push(`Room: ${snap.room} → ${r.room}`);
  if (snap.channel !== r.channel)   diffs.push(`Channel: ${snap.channel} → ${r.channel}`);
  return diffs;
}

function mergeLocal(reservations: Reservation[], state: Record<string, LocalFields>): Reservation[] {
  return reservations.map((r) => {
    const local = state[r.reservationNumber];
    return local ? { ...r, ...local } : r;
  });
}

// Persists local fields. Throws on failure so the caller can show error feedback;
// callers that don't care can wrap in their own try/catch.
async function persistOverride(reservationNumber: string, fields: LocalFields): Promise<void> {
  const res = await fetch('/api/local-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reservationNumber, fields }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error ?? `HTTP ${res.status}`);
  }
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const UNREAD_POLL_INTERVAL_MS = 30_000;

/** Czech translation state for one entry in the approval panel. */
type PanelTxState = 'loading' | 'error' | { text: string; lang: string };

/** Read-only Czech rendering of a panel translation (guest message or draft).
 *  Renders nothing when absent, when the source is already Czech, or empty. */
function PanelCzech({
  entry,
  tone,
  onRefresh,
}: {
  entry: PanelTxState | undefined;
  tone: 'violet' | 'indigo';
  onRefresh?: () => void;
}) {
  const muted = tone === 'violet' ? 'text-violet-400' : 'text-indigo-400';
  if (!entry) return null;
  if (entry === 'loading') return <div className={`text-[11px] italic mt-0.5 ${muted}`}>Překládám…</div>;
  if (entry === 'error') return <div className={`text-[11px] italic mt-0.5 ${muted}`}>Překlad nedostupný</div>;
  if (!entry.text || entry.lang === 'cs') return null;
  const box =
    tone === 'violet'
      ? 'bg-violet-100/50 text-violet-800 ring-violet-200'
      : 'bg-indigo-100/50 text-indigo-800 ring-indigo-200';
  return (
    <div className={`text-[12px] mt-1 mb-1 rounded px-2 py-1 ring-1 ${box} flex items-start gap-1.5`}>
      <span className="shrink-0" aria-hidden>🇨🇿</span>
      <span className="flex-1 whitespace-pre-wrap">{entry.text}</span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          title="Re-translate the current text"
          className="shrink-0 opacity-60 hover:opacity-100"
        >
          ↻
        </button>
      )}
    </div>
  );
}

const LANG_LABELS: Record<string, string> = {
  en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish',
  pl: 'Polish', ru: 'Russian', sk: 'Slovak', uk: 'Ukrainian', nl: 'Dutch',
  pt: 'Portuguese', hu: 'Hungarian', cs: 'Czech',
};
function langLabel(code: string): string {
  return LANG_LABELS[code.toLowerCase()] ?? code.toUpperCase();
}

export default function TransactionsPage() {
  const { data: session } = useSession();
  const role = (session?.user as { role?: Role } | undefined)?.role;

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [unreadBookingIds, setUnreadBookingIds] = useState<Set<number>>(new Set());
  // Enriched per-booking metadata fetched alongside the unread badge poll.
  // Drives the "X unread messages" pill panel near the top of the page.
  const [unreadBookings, setUnreadBookings] = useState<UnreadBookingSummary[]>([]);
  const [unreadPanelOpen, setUnreadPanelOpen] = useState(false);
  // Pending operator-approval drafts (Section A in the panel) and queued
  // `other`-category messages (Section B). Both arrive from the same
  // /api/messages/unread poll. Edit state is per-messageId so the
  // operator can tweak one draft without losing changes on the others.
  const [pendingDrafts, setPendingDrafts] = useState<PendingDraft[]>([]);
  const [pendingOthers, setPendingOthers] = useState<PendingOther[]>([]);
  const [draftEdits, setDraftEdits] = useState<Record<number, string>>({});
  const [draftBusy, setDraftBusy] = useState<Record<number, 'sending' | 'dismissing' | undefined>>({});
  // Czech translations for the approval panel, keyed `${messageId}:guest` /
  // `${messageId}:draft`. Auto-filled so the operator can read foreign-language
  // guest messages and AI drafts; the editable draft itself stays in the
  // guest's language (that's what actually gets sent).
  const [panelTx, setPanelTx] = useState<Record<string, PanelTxState>>({});
  // "Show translation" previews of the outgoing (guest-language) message,
  // keyed by messageId. `czech` records the source the preview was made from,
  // so we can tell when the operator has edited since previewing — and send
  // that exact checked translation on approve.
  const [previewTx, setPreviewTx] = useState<
    Record<number, { czech: string; translated: string } | 'loading' | 'error'>
  >({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showBlackoutModal, setShowBlackoutModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showVoucherModal, setShowVoucherModal] = useState(false);
  const [showPriceCheck, setShowPriceCheck] = useState(false);
  const [paymentAlertOpen, setPaymentAlertOpen] = useState(false);
  // Single source of truth for "are we saving / did we save / did it fail" so
  // the drawer can render one consistent toast for any onUpdate-driven write.
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchReservations = useCallback(async (opts?: { fullSync?: boolean }) => {
    // A forced sync (manual "Sync", error/conflict "Retry/Refresh", phone-booking
    // creation) appends ?fullSync=true to bypass the server's 90s min-sync guard.
    // Automatic refetches (mount / tab-switch remount) omit it so they coalesce.
    // `=== true` keeps event/object args from the other call sites (onClick,
    // onPaymentCreated, …) safely resolving to a guarded refresh.
    const fullSync = opts?.fullSync === true;
    setIsLoading(true);
    setError(null);
    try {
      const [bookingsRes, localStateRes, additionalPaymentsRes, vouchersRes, splitPaymentsRes, invoiceRequestsRes, emailLogRes] = await Promise.all([
        fetch(`/api/bookings${fullSync ? "?fullSync=true" : ""}`),
        fetch("/api/local-state"),
        fetch("/api/stripe/additional-payments"),
        fetch("/api/vouchers"),
        fetch("/api/stripe/split-payments"),
        fetch("/api/invoice-requests"),
        fetch("/api/email-send-log"),
      ]);
      if (!bookingsRes.ok) {
        const json = await bookingsRes.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${bookingsRes.status}`);
      }
      const data: Reservation[] = await bookingsRes.json();
      const localState: Record<string, LocalFields> = localStateRes.ok
        ? await localStateRes.json().catch(() => ({}))
        : {};
      const allAdditionalPayments: AdditionalPayment[] = additionalPaymentsRes.ok
        ? await additionalPaymentsRes.json().catch(() => [])
        : [];
      const allVouchers: Voucher[] = vouchersRes.ok
        ? await vouchersRes.json().catch(() => [])
        : [];
      const splitPaymentsBody = splitPaymentsRes.ok
        ? await splitPaymentsRes.json().catch(() => ({}))
        : {};
      const allSplitPayments: SplitPayment[] = Array.isArray(splitPaymentsBody?.payments)
        ? splitPaymentsBody.payments
        : [];
      const allInvoiceRequests: InvoiceRequest[] = invoiceRequestsRes.ok
        ? await invoiceRequestsRes.json().catch(() => [])
        : [];
      const allEmailLogEntries: EmailSendLogEntry[] = emailLogRes.ok
        ? await emailLogRes.json().catch(() => [])
        : [];

      // Group additional payments by reservationNumber for merge
      const apByRes = new Map<string, AdditionalPayment[]>();
      for (const ap of allAdditionalPayments) {
        const group = apByRes.get(ap.reservationNumber) ?? [];
        group.push(ap);
        apByRes.set(ap.reservationNumber, group);
      }

      // Group vouchers by reservationNumber for merge.
      // A voucher attaches to a reservation if it was either CREATED FOR it
      // or REDEEMED ON it — both keys are valid joins so the operator sees
      // the voucher in the drawer regardless of which side they came from.
      // Deduped via Set so a voucher with both fields equal isn't doubled.
      const vByRes = new Map<string, Voucher[]>();
      for (const v of allVouchers) {
        const targets = new Set<string>();
        if (v.reservationNumber) targets.add(v.reservationNumber);
        if (v.redeemedOnReservationNumber) targets.add(v.redeemedOnReservationNumber);
        for (const resNum of targets) {
          const group = vByRes.get(resNum) ?? [];
          group.push(v);
          vByRes.set(resNum, group);
        }
      }

      // Group split payments by reservationNumber for merge
      const spByRes = new Map<string, SplitPayment[]>();
      for (const sp of allSplitPayments) {
        const group = spByRes.get(sp.reservationNumber) ?? [];
        group.push(sp);
        spByRes.set(sp.reservationNumber, group);
      }

      // Group invoice requests by reservationNumber for merge
      const irByRes = new Map<string, InvoiceRequest[]>();
      for (const ir of allInvoiceRequests) {
        const group = irByRes.get(ir.reservationNumber) ?? [];
        group.push(ir);
        irByRes.set(ir.reservationNumber, group);
      }

      // Group email-send-log entries by reservationNumber, sorted newest first
      // (drawer renders the most recent one most prominently).
      const elByRes = new Map<string, EmailSendLogEntry[]>();
      for (const el of allEmailLogEntries) {
        const group = elByRes.get(el.reservationNumber) ?? [];
        group.push(el);
        elByRes.set(el.reservationNumber, group);
      }
      for (const group of elByRes.values()) {
        group.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
      }

      // Stripe fees are aggregated server-side in /api/bookings now, so we just
      // attach the AdditionalPayments + Vouchers + SplitPayments + InvoiceRequests
      // and let the API's value flow through.
      const merged = mergeLocal(data, localState).map((r) => {
        const aps = apByRes.get(r.reservationNumber);
        const vs = vByRes.get(r.reservationNumber);
        const sps = spByRes.get(r.reservationNumber);
        const irs = irByRes.get(r.reservationNumber);
        const els = elByRes.get(r.reservationNumber);
        return {
          ...r,
          ...(aps ? { additionalPayments: aps } : {}),
          ...(vs ? { vouchers: vs } : {}),
          ...(sps ? { splitPayments: sps } : {}),
          ...(irs ? { invoiceRequests: irs } : {}),
          ...(els ? { emailSendLog: els } : {}),
        };
      });
      setReservations(merged);
      setLastSynced(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reservations");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReservations();
  }, [fetchReservations]);

  // Poll for unread guest messages every 30s — drives both the table-level
  // blinking badge AND the new "unread messages" pill panel.
  useEffect(() => {
    async function pollUnread() {
      try {
        const res = await fetch('/api/messages/unread');
        if (!res.ok) return;
        const body: {
          bookingIds: number[];
          bookings?: UnreadBookingSummary[];
          pendingDrafts?: PendingDraft[];
          pendingOthers?: PendingOther[];
        } = await res.json();
        setUnreadBookingIds(new Set(body.bookingIds));
        setUnreadBookings(body.bookings ?? []);
        setPendingDrafts(body.pendingDrafts ?? []);
        setPendingOthers(body.pendingOthers ?? []);
      } catch {
        // fail silently — badge just won't update until next poll
      }
    }
    pollUnread();
    const id = setInterval(pollUnread, UNREAD_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Approve a pending draft: optionally with edited text, send via the
  // /api/messages/draft/[messageId] endpoint, then locally drop the
  // entry so the panel updates immediately (next poll reconciles).
  const approveDraft = useCallback(
    async (messageId: number, text: string, preTranslated = false, sourceText?: string) => {
      if (!text.trim()) return;
      setDraftBusy((prev) => ({ ...prev, [messageId]: 'sending' }));
      try {
        const res = await fetch(`/api/messages/draft/${messageId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, preTranslated, sourceText: sourceText ?? text }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        setPendingDrafts((prev) => prev.filter((d) => d.beds24MessageId !== messageId));
        setPendingOthers((prev) => prev.filter((o) => o.beds24MessageId !== messageId));
        setDraftEdits((prev) => {
          const next = { ...prev };
          delete next[messageId];
          return next;
        });
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Send failed');
      } finally {
        setDraftBusy((prev) => {
          const next = { ...prev };
          delete next[messageId];
          return next;
        });
      }
    },
    [],
  );

  const dismissDraft = useCallback(async (messageId: number) => {
    setDraftBusy((prev) => ({ ...prev, [messageId]: 'dismissing' }));
    try {
      const res = await fetch(`/api/messages/draft/${messageId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setPendingDrafts((prev) => prev.filter((d) => d.beds24MessageId !== messageId));
      setPendingOthers((prev) => prev.filter((o) => o.beds24MessageId !== messageId));
      setDraftEdits((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Dismiss failed');
    } finally {
      setDraftBusy((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
    }
  }, []);

  // Translate a panel entry (guest message or draft) to Czech via /api/translate.
  const translatePanel = useCallback(async (key: string, text: string) => {
    if (!text?.trim()) return;
    setPanelTx((prev) => ({ ...prev, [key]: 'loading' }));
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'translate failed');
      setPanelTx((prev) => ({ ...prev, [key]: { text: data.translatedText, lang: data.detectedLanguage } }));
    } catch {
      setPanelTx((prev) => ({ ...prev, [key]: 'error' }));
    }
  }, []);

  // "Show translation": preview the outgoing message in the guest's language
  // using the SAME Sonnet translator the send step uses, so what the operator
  // checks is what gets sent.
  const previewTranslation = useCallback(async (messageId: number, czech: string, targetLang: string) => {
    if (!czech.trim() || !targetLang) return;
    setPreviewTx((prev) => ({ ...prev, [messageId]: 'loading' }));
    try {
      const res = await fetch('/api/translate-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: czech, targetLang }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'translate failed');
      setPreviewTx((prev) => ({ ...prev, [messageId]: { czech, translated: data.translated } }));
    } catch {
      setPreviewTx((prev) => ({ ...prev, [messageId]: 'error' }));
    }
  }, []);

  // Auto-translate each pending guest message to Czech, once (plus any legacy
  // guest-language draft). Czech AI drafts skip translation — the operator
  // edits them directly. Guarded by `panelTx[key]` so the 30s poll never
  // re-fires a done / loading / errored entry; converges per key.
  useEffect(() => {
    const rows = [
      ...pendingDrafts.map((d) => ({
        id: d.beds24MessageId,
        guest: d.guestMessageText,
        draft: d.draftLanguage === 'cs' ? '' : d.draftText,
      })),
      ...pendingOthers.map((o) => ({ id: o.beds24MessageId, guest: o.guestMessageText, draft: o.draftText })),
    ];
    for (const r of rows) {
      const gk = `${r.id}:guest`;
      const dk = `${r.id}:draft`;
      if (r.guest?.trim() && !panelTx[gk]) translatePanel(gk, r.guest);
      if (r.draft?.trim() && !panelTx[dk]) translatePanel(dk, r.draft);
    }
  }, [pendingDrafts, pendingOthers, panelTx, translatePanel]);

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [taskAlertOpen, setTaskAlertOpen] = useState(false);
  const [earlyCheckinPanelOpen, setEarlyCheckinPanelOpen] = useState(false);
  const [lateCheckoutPanelOpen, setLateCheckoutPanelOpen] = useState(false);
  const [unallocatedPanelOpen, setUnallocatedPanelOpen] = useState(false);
  const [blackoutsPanelOpen, setBlackoutsPanelOpen] = useState(false);
  /** Per-blackout deletion state (reservationNumber → pending). Keeps the
   *  "Remove" button responsive when the operator clicks multiple in
   *  quick succession. */
  const [removingBlackoutId, setRemovingBlackoutId] = useState<string | null>(null);
  const [postStayPanelOpen, setPostStayPanelOpen] = useState(false);
  const [ackingPostStayId, setAckingPostStayId] = useState<string | null>(null);

  interface DataIssue {
    reservation: Reservation;
    problems: string[];
  }

  // ── Unresolved issues — overdue + actionable within the next 7 days ─────────
  // Overdue rows (actionableDate < today) are included with a flag so the table
  // can flag them visually. Sort: overdue oldest first, then upcoming soonest first.
  //
  // The full list is then split into three independent banner pills so the
  // operator sees a clean count per category instead of one big "X tasks":
  //   - earlyCheckin tasks → teal "X early check-ins" pill
  //   - lateCheckout tasks → orange "Y late checkout requests" pill
  //   - everything else (problem / invoice / cleaning / special) → red
  //                                                                 "Z pending tasks" pill
  const allUpcomingUnresolved = useMemo(() => {
    // Use local date (sv-SE locale = YYYY-MM-DD), same as date pickers in the drawer
    const today = new Date().toLocaleDateString("sv-SE");
    const d7 = new Date(); d7.setDate(d7.getDate() + 7);
    const in7 = d7.toLocaleDateString("sv-SE");
    const items: { reservation: Reservation; issue: Issue; overdue: boolean }[] = [];
    for (const r of reservations) {
      for (const issue of r.issues ?? []) {
        if (issue.resolved) continue;
        if (issue.actionableDate < today) {
          items.push({ reservation: r, issue, overdue: true });
        } else if (issue.actionableDate <= in7) {
          items.push({ reservation: r, issue, overdue: false });
        }
      }
    }
    return items.sort((a, b) => a.issue.actionableDate.localeCompare(b.issue.actionableDate));
  }, [reservations]);

  /** "Generic" pending tasks = everything that isn't the dedicated
   *  early-checkin / late-checkout request lanes. Keeps the original red
   *  pill focused on operator-actionable items: problems, invoices to
   *  send, mid-stay cleanings, special-treatment notes. */
  const upcomingUnresolved = useMemo(
    () =>
      allUpcomingUnresolved.filter((x) => {
        const cat = x.issue.category ?? "problem";
        return cat !== "earlyCheckin" && cat !== "lateCheckout";
      }),
    [allUpcomingUnresolved],
  );

  // Early check-in / late checkout requests become moot once their date
  // passes (the arrival/departure already happened), so — unlike the generic
  // pending-tasks pill — these two banners drop overdue rows and show only
  // upcoming (today … +7). Otherwise past requests linger indefinitely.
  const upcomingEarlyCheckins = useMemo(
    () => allUpcomingUnresolved.filter((x) => x.issue.category === "earlyCheckin" && !x.overdue),
    [allUpcomingUnresolved],
  );

  const upcomingLateCheckouts = useMemo(
    () => allUpcomingUnresolved.filter((x) => x.issue.category === "lateCheckout" && !x.overdue),
    [allUpcomingUnresolved],
  );

  const overdueCount = useMemo(
    () => upcomingUnresolved.filter((x) => x.overdue).length,
    [upcomingUnresolved],
  );

  /**
   * Reservations sitting on a virtual room with no physical allocation —
   * Beds24 couldn't auto-allocate (e.g. no single room is free for the
   * whole stay). Surfaced as a dedicated amber pill in the task bar so
   * the operator can jump into Beds24 and manually assign. This is
   * computed from `Reservation.isUnallocatedVR` (set in /api/bookings)
   * and clears itself the moment the operator transfers the booking.
   */
  const unallocatedReservations = useMemo(
    () => reservations.filter((r) => r.isUnallocatedVR),
    [reservations],
  );

  /**
   * Per-unallocated-booking resolution plan: the fewest within-type moves to
   * give it a physical unit, computed from the live reservations in memory.
   * Recomputed whenever bookings change so a just-executed move clears it.
   */
  const unallocatedPlans = useMemo(() => {
    const today = new Date().toLocaleDateString("sv-SE");
    const map: Record<string, ReturnType<typeof planForUnallocated>> = {};
    for (const r of unallocatedReservations) {
      map[r.reservationNumber] = planForUnallocated(reservations, r.reservationNumber, today);
    }
    return map;
  }, [unallocatedReservations, reservations]);

  /** Booking# currently being applied to Beds24, + per-booking error text. */
  const [resolveBusy, setResolveBusy] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<Record<string, string>>({});

  const executeReallocation = useCallback(
    async (targetResNum: string) => {
      const result = unallocatedPlans[targetResNum];
      if (!result || "error" in result || !result.plan.feasible) return;
      const { plan } = result;
      const moves = [
        ...plan.moves.map((m) => ({ reservationNumber: m.reservationNumber, toRoom: m.to })),
        ...plan.placements.map((p) => ({ reservationNumber: p.reservationNumber, toRoom: p.room })),
      ];
      setResolveBusy(targetResNum);
      setResolveError((prev) => {
        const next = { ...prev };
        delete next[targetResNum];
        return next;
      });
      try {
        const res = await fetch("/api/bookings/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ moves, reason: "Resolve unallocated reservation" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        await fetchReservations();
      } catch (e) {
        setResolveError((prev) => ({
          ...prev,
          [targetResNum]: e instanceof Error ? e.message : "Move failed",
        }));
      } finally {
        setResolveBusy(null);
      }
    },
    [unallocatedPlans, fetchReservations],
  );

  /**
   * Active blackouts = blackouts that are still blocking future dates
   * (checkOutDate > today). Past blackouts stay in the data — they're
   * useful for occupancy/historical metrics — but they're not
   * actionable, so we hide them from the "remove blackout" panel.
   *
   * Sorted by start date so the soonest-active is at the top.
   */
  const activeBlackouts = useMemo(() => {
    const today = new Date().toLocaleDateString("sv-SE");
    return reservations
      .filter((r) => r.isBlackout && r.checkOutDate > today)
      .sort((a, b) => a.checkInDate.localeCompare(b.checkInDate));
  }, [reservations]);

  /**
   * Post-stay modifications: reservations whose `modifiedAt` is after
   * the checkout date. Catches the failure mode the operator described:
   * they extend a guest's stay in Beds24, then later a channel
   * (Booking.com / Airbnb) re-syncs and reverts the change to the
   * original dates. Either side of that flip-flop bumps `modifiedAt`,
   * so we surface it as a heads-up rather than silently letting the
   * data revert without the operator noticing.
   *
   * Already-acknowledged modifications drop out (the ack timestamp
   * stored on the reservation must be ≥ `modifiedAt` for the flag to
   * clear). Blackouts excluded — their data changes are operator-driven
   * by design.
   */
  const postStayChanges = useMemo(() => {
    const today = new Date().toLocaleDateString("sv-SE");
    return reservations
      .filter((r) => {
        if (r.isBlackout) return false;
        if (!r.checkOutDate || !r.modifiedAt) return false;
        if (r.checkOutDate >= today) return false;
        const modifiedDate = r.modifiedAt.slice(0, 10);
        if (modifiedDate <= r.checkOutDate) return false;
        if (r.postStayAcknowledgedAt && r.postStayAcknowledgedAt >= r.modifiedAt) {
          return false;
        }
        return true;
      })
      .sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  }, [reservations]);

  async function acknowledgePostStayChange(reservation: Reservation) {
    if (ackingPostStayId) return;
    if (!reservation.modifiedAt) return;
    setAckingPostStayId(reservation.reservationNumber);
    try {
      // Merge: keep all existing local overrides, just stamp the ack
      // AND snapshot the current state. The snapshot becomes the
      // baseline for future diff display — if Beds24 modifies the
      // booking again, the next alert will show exactly which fields
      // drifted from this state.
      //
      // We persist EVERY local field because /api/local-state POST
      // replaces (not merges) the per-reservation entry server-side.
      const fields = extractLocalFields(reservation);
      fields.postStayAcknowledgedAt = reservation.modifiedAt;
      fields.postStaySnapshot = {
        capturedAt: new Date().toISOString(),
        checkInDate:    reservation.checkInDate,
        checkOutDate:   reservation.checkOutDate,
        numberOfNights: reservation.numberOfNights,
        numberOfGuests: reservation.numberOfGuests,
        price:          reservation.price,
        room:           reservation.room,
        channel:        reservation.channel,
      };
      await persistOverride(reservation.reservationNumber, fields);
      await fetchReservations();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to acknowledge change');
    } finally {
      setAckingPostStayId(null);
    }
  }

  async function removeBlackout(reservationNumber: string) {
    if (removingBlackoutId) return; // one at a time
    if (!confirm('Remove this blackout? The room will be re-opened for sale on those dates.')) {
      return;
    }
    setRemovingBlackoutId(reservationNumber);
    try {
      const res = await fetch(
        `/api/bookings/blackout?id=${encodeURIComponent(reservationNumber)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      // Force a fresh fetch so the calendar + reservation list update
      // immediately. The override-blackout fetch path also re-runs on
      // every /api/bookings GET, so the removed override drops out of
      // the synthetic-reservation list naturally.
      await fetchReservations();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to remove blackout');
    } finally {
      setRemovingBlackoutId(null);
    }
  }

  // ── Unpaid additional payments (Stripe payment links not yet paid) ───────────
  const unpaidAdditionalPayments = useMemo(() => {
    const items: { reservation: Reservation; payment: AdditionalPayment }[] = [];
    for (const r of reservations) {
      for (const ap of r.additionalPayments ?? []) {
        if (ap.status === "unpaid") {
          items.push({ reservation: r, payment: ap });
        }
      }
    }
    return items.sort((a, b) => a.payment.createdAt.localeCompare(b.payment.createdAt));
  }, [reservations]);

  const dataIssues = useMemo<DataIssue[]>(() => {
    const today = new Date().toLocaleDateString("sv-SE"); // local YYYY-MM-DD
    return reservations
      .filter((r) => r.paymentStatus !== "Refunded")
      .flatMap((r) => {
        const problems: string[] = [];
        if (r.channel === "Booking.com") {
          if (r.commissionAmount === 0) problems.push("Commission missing");
        }
        if (r.channel === "Airbnb") {
          if (r.commissionAmount === 0) problems.push("Host fee missing");
        }
        // Rate type — current/future OTA stays or any booked since launch.
        // Missing when neither detected nor set manually.
        if (isRateTypeInScope(r, today) && !effectiveRateType(r)) {
          problems.push("Rate type missing");
        }
        return problems.length > 0 ? [{ reservation: r, problems }] : [];
      });
  }, [reservations]);

  const filtered = useMemo(() => {
    return reservations.filter((res) => {
      // Search (diacritic-insensitive)
      if (search.trim()) {
        const q = normalizeForSearch(search);
        const fullName = normalizeForSearch(`${res.firstName} ${res.lastName}`);
        if (
          !res.reservationNumber.toLowerCase().includes(q) &&
          !fullName.includes(q) &&
          !normalizeForSearch(res.email).includes(q)
        ) {
          return false;
        }
      }

      // Channel filter
      if (filters.channels.length > 0 && !filters.channels.includes(res.channel)) return false;

      // Room filter — also match if any linked room (package booking) matches
      if (
        filters.rooms.length > 0 &&
        !filters.rooms.includes(res.room) &&
        !res.linkedRooms?.some((r) => filters.rooms.includes(r))
      ) return false;

      // Payment status
      if (
        filters.paymentStatuses.length > 0 &&
        !filters.paymentStatuses.includes(res.paymentStatus)
      )
        return false;

      // Customer flags — uses effective flags (auto + overrides)
      if (filters.customerFlags.length > 0) {
        const effective = getEffectiveFlags(res, reservations);
        const hasAll = filters.customerFlags.every((f) => effective.includes(f));
        if (!hasAll) return false;
      }

      // Guest rating — good / bad / unrated (matches the smiley in the table)
      if (filters.ratings.length > 0 && !filters.ratings.includes(ratingClass(res))) return false;

      // Date range
      if (filters.checkInFrom && res.checkInDate < filters.checkInFrom) return false;
      if (filters.checkInTo && res.checkInDate > filters.checkInTo) return false;

      return true;
    });
  }, [reservations, search, filters]);

  async function handleUpdate(updated: Reservation) {
    // Optimistic UI: reflect the change locally before the server confirms.
    setReservations((prev) =>
      prev.map((r) => r.reservationNumber === updated.reservationNumber ? updated : r)
    );
    setSelectedReservation(updated);

    // Track save lifecycle so the drawer can surface "Saving… / Saved / Failed".
    if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    setSaveStatus('saving');
    try {
      await persistOverride(updated.reservationNumber, extractLocalFields(updated));
      setSaveStatus('saved');
      saveStatusTimer.current = setTimeout(() => setSaveStatus('idle'), 2200);
    } catch (err) {
      console.error('[persistOverride] Failed to save changes for', updated.reservationNumber, err);
      setSaveStatus('error');
      saveStatusTimer.current = setTimeout(() => setSaveStatus('idle'), 5000);
    }
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6">
      {/* Availability calendar */}
      {!isLoading && (
        <OccupancyCalendar
          reservations={reservations}
          onReservationClick={setSelectedReservation}
        />
      )}

{/* large banner removed — compact pill lives above the filter instead */}

      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Reservations</h1>
          {(() => {
            // "Real" reservations = everything currently in view minus blackouts
            // (Beds24 cancellations are already excluded by the /api/bookings
            // sync — status="cancelled" rows are filtered out server-side.)
            const realCount = reservations.filter((r) => !r.isBlackout).length;
            const blackoutCount = reservations.length - realCount;
            // "Served" = stays we've actually delivered: checked out (departure
            // in the past) OR currently in-house — i.e. the stay has started
            // (check-in today or earlier). Excludes future + blackouts.
            const today = new Date().toLocaleDateString("sv-SE");
            const servedCount = reservations.filter(
              (r) => !r.isBlackout && r.checkInDate <= today,
            ).length;
            return (
              <p
                className="text-sm text-gray-400 mt-0.5"
                title="Cancellations are already excluded from the sync. Blackouts (status=black) are counted separately. “Served” = stays already checked out or currently in-house."
              >
                {realCount} reservation{realCount === 1 ? '' : 's'}
                {' '}
                <span className="text-gray-500">({servedCount} served)</span>
                {blackoutCount > 0 && <> · {blackoutCount} blackout{blackoutCount === 1 ? '' : 's'}</>}
                {' · '}{filtered.length} shown
              </p>
            );
          })()}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden sm:inline text-xs text-gray-400">
            Last synced:{" "}
            <span className="text-gray-600">
              {lastSynced ? lastSynced.toLocaleTimeString() : "—"}
            </span>
          </span>
          {role && canMutate(role, "transactions") && (
            <>
            <button
              onClick={() => setShowPriceCheck(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-white border border-emerald-200 text-emerald-700 text-sm font-medium transition-colors hover:bg-emerald-50 shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Price Check
            </button>
            <button
              onClick={() => setShowVoucherModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-white border border-purple-200 text-purple-700 text-sm font-medium transition-colors hover:bg-purple-50 shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
              </svg>
              Create Voucher
            </button>
            <button
              onClick={() => setShowPaymentModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-white border border-indigo-200 text-indigo-700 text-sm font-medium transition-colors hover:bg-indigo-50 shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              Manual Payment
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Booking
            </button>
            <button
              onClick={() => setShowBlackoutModal(true)}
              title="Close a room for a date range without creating a reservation"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium transition-colors shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
              Black Out
            </button>
            </>
          )}
          <button
            onClick={() => fetchReservations({ fullSync: true })}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg
              className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {isLoading ? "Syncing…" : "Sync"}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>Failed to load reservations: {error}</span>
          <button onClick={() => fetchReservations({ fullSync: true })} className="ml-auto font-medium underline underline-offset-2 hover:text-red-900">
            Retry
          </button>
        </div>
      )}

      {/* Overlap alert — surfaces same-room double-bookings. Driven by the
          server-tagged `overlapWith` field. Each conflict appears once
          (pairs are de-duplicated by sorting endpoints). One room can only
          host one booking at a time, so any hit here means either a cache
          staleness bug or a real Beds24 double-book the operator needs to
          resolve. */}
      {(() => {
        const conflictPairs = new Set<string>();
        const pairList: Array<{ a: string; b: string; room: string }> = [];
        for (const r of reservations) {
          for (const other of r.overlapWith ?? []) {
            const key = [r.reservationNumber, other].sort().join('|');
            if (conflictPairs.has(key)) continue;
            conflictPairs.add(key);
            pairList.push({ a: r.reservationNumber, b: other, room: r.room });
          }
        }
        if (pairList.length === 0) return null;
        return (
          <div className="mb-5 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 shrink-0 text-red-500 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-red-900">
                  Same-room conflict detected ({pairList.length} {pairList.length === 1 ? 'pair' : 'pairs'})
                </p>
                <p className="text-[12px] text-red-700 mt-0.5">
                  Two or more reservations occupy the same room on overlapping dates — one of them is almost
                  certainly a cancellation that didn&apos;t reach the cache. Verify on Beds24 and click Refresh
                  if needed.
                </p>
                <ul className="mt-2 space-y-0.5 text-[12px] font-mono">
                  {pairList.map((p) => (
                    <li key={`${p.a}|${p.b}`}>
                      {p.room}: <span className="font-semibold">{p.a}</span> ↔ <span className="font-semibold">{p.b}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <button
                onClick={() => fetchReservations({ fullSync: true })}
                className="font-medium underline underline-offset-2 hover:text-red-900"
              >
                Refresh
              </button>
            </div>
          </div>
        );
      })()}

      {/* Data issues panel */}
      {dataIssues.length > 0 && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
          <button
            onClick={() => setIssuesOpen((o) => !o)}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-amber-800 hover:bg-amber-100 transition-colors"
          >
            <svg className="w-4 h-4 shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span className="font-medium">
              {dataIssues.length} data {dataIssues.length === 1 ? "issue" : "issues"} detected
            </span>
            <span className="text-amber-500 text-xs ml-1">
              {(() => {
                const kinds = new Set(dataIssues.flatMap((d) => d.problems));
                const bits: string[] = [];
                if (kinds.has("Commission missing") || kinds.has("Host fee missing")) bits.push("commission");
                if (kinds.has("Rate type missing")) bits.push("rate plan");
                return bits.length > 0 ? `Missing ${bits.join(" + ")} data from Beds24` : "Needs attention";
              })()}
            </span>
            <svg
              className={`w-4 h-4 ml-auto text-amber-400 transition-transform ${issuesOpen ? "rotate-180" : ""}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {issuesOpen && (
            <div className="border-t border-amber-200 px-4 pb-3">
              <table className="w-full text-sm mt-3">
                <thead>
                  <tr className="border-b border-amber-200">
                    {["Reservation", "Channel", "Check-in", "Issue"].map((h) => (
                      <th key={h} className={`pb-2 text-xs font-medium text-amber-700 uppercase tracking-wide ${h === "Issue" ? "text-right" : "text-left"}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100">
                  {dataIssues.map(({ reservation: r, problems }) => (
                    <tr
                      key={r.reservationNumber}
                      className="hover:bg-amber-100 cursor-pointer"
                      onClick={() => { setSelectedReservation(r); setIssuesOpen(false); }}
                    >
                      <td className="py-2 font-medium text-amber-900">{r.reservationNumber}</td>
                      <td className="py-2 text-amber-700">{r.channel}</td>
                      <td className="py-2 text-amber-700">{r.checkInDate}</td>
                      <td className="py-2 text-right text-amber-600">{problems.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Pending tasks + Unread messages pills — same row above the
          search bar so the operator's actionable surface is one glance.
          Panels expand BELOW the pill row (full width), not next to
          their pill, so the wide tables get the space they need. */}
      {(upcomingUnresolved.length > 0
        || unreadBookings.length > 0
        || upcomingEarlyCheckins.length > 0
        || upcomingLateCheckouts.length > 0
        || unallocatedReservations.length > 0
        || activeBlackouts.length > 0
        || postStayChanges.length > 0) && (
        <div className="mb-3 space-y-2">
          {/* Pills row */}
          <div className="flex flex-wrap items-start gap-2">
            {upcomingUnresolved.length > 0 && (
              <button
                onClick={() => setTaskAlertOpen((o) => !o)}
                // Pill is RED when anything is overdue (real urgency), AMBER
                // when everything's still upcoming (heads-up only). Stops the
                // "everything is red" anxiety when the only pending items
                // are e.g. invoice-send tasks dated for next week's checkout.
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  overdueCount > 0
                    ? 'bg-red-50 border border-red-200 text-red-700 hover:bg-red-100'
                    : 'bg-amber-50 border border-amber-200 text-amber-800 hover:bg-amber-100'
                }`}
              >
                <span
                  className={`flex items-center justify-center w-4 h-4 rounded-full text-white text-[9px] font-bold shrink-0 ${
                    overdueCount > 0 ? 'bg-red-500 animate-pulse' : 'bg-amber-500'
                  }`}
                >!</span>
                {upcomingUnresolved.length} pending {upcomingUnresolved.length === 1 ? "task" : "tasks"}
                {overdueCount > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded bg-red-600 text-white text-[10px] font-bold uppercase tracking-wide">
                    {overdueCount} overdue
                  </span>
                )}
                <span className={`font-normal ${overdueCount > 0 ? 'text-red-500' : 'text-amber-600'}`}>· next 7 days</span>
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${taskAlertOpen ? "rotate-180" : ""}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {unallocatedReservations.length > 0 && (
              <button
                onClick={() => setUnallocatedPanelOpen((o) => !o)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-300 text-amber-800 text-sm font-medium hover:bg-amber-100 transition-colors"
              >
                <span className="flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 text-white text-[10px] font-bold shrink-0">⚠</span>
                {unallocatedReservations.length} room {unallocatedReservations.length === 1 ? "assignment" : "assignments"} needed
                <span className="text-amber-600 font-normal">· assign in Beds24</span>
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${unallocatedPanelOpen ? "rotate-180" : ""}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {postStayChanges.length > 0 && (
              <button
                onClick={() => setPostStayPanelOpen((o) => !o)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple-50 border border-purple-200 text-purple-800 text-sm font-medium hover:bg-purple-100 transition-colors"
              >
                <svg className="w-3.5 h-3.5 shrink-0 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {postStayChanges.length} past-stay {postStayChanges.length === 1 ? "change" : "changes"}
                <span className="text-purple-600 font-normal">· review</span>
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${postStayPanelOpen ? "rotate-180" : ""}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {activeBlackouts.length > 0 && (
              <button
                onClick={() => setBlackoutsPanelOpen((o) => !o)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-50 border border-rose-300 text-rose-800 text-sm font-medium hover:bg-rose-100 transition-colors"
              >
                <svg className="w-3.5 h-3.5 shrink-0 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 105.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
                {activeBlackouts.length} active {activeBlackouts.length === 1 ? "blackout" : "blackouts"}
                <span className="text-rose-600 font-normal">· manage</span>
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${blackoutsPanelOpen ? "rotate-180" : ""}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {upcomingEarlyCheckins.length > 0 && (
              <button
                onClick={() => setEarlyCheckinPanelOpen((o) => !o)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-50 border border-teal-200 text-teal-700 text-sm font-medium hover:bg-teal-100 transition-colors"
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="9" strokeWidth={2} />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 7v5l3 2" />
                </svg>
                {upcomingEarlyCheckins.length} early check-{upcomingEarlyCheckins.length === 1 ? "in" : "ins"}
                <span className="text-teal-500 font-normal">· next 7 days</span>
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${earlyCheckinPanelOpen ? "rotate-180" : ""}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {upcomingLateCheckouts.length > 0 && (
              <button
                onClick={() => setLateCheckoutPanelOpen((o) => !o)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-orange-50 border border-orange-200 text-orange-700 text-sm font-medium hover:bg-orange-100 transition-colors"
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M6 3h12M6 21h12M8 3v3a4 4 0 008 0V3M8 21v-3a4 4 0 018-0v3" />
                </svg>
                {upcomingLateCheckouts.length} late checkout {upcomingLateCheckouts.length === 1 ? "request" : "requests"}
                <span className="text-orange-500 font-normal">· next 7 days</span>
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${lateCheckoutPanelOpen ? "rotate-180" : ""}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {(() => {
              const pendingMsgIds = new Set<number>([
                ...pendingDrafts.map((d) => d.beds24MessageId),
                ...pendingOthers.map((o) => o.beds24MessageId),
              ]);
              const pendingBookingIds = new Set<number>([
                ...pendingDrafts.map((d) => d.bookingId),
                ...pendingOthers.map((o) => o.bookingId),
              ]);
              const unprocessedUnread = unreadBookings.filter(
                (b) => !pendingBookingIds.has(b.bookingId),
              );
              const totalAttention =
                pendingDrafts.length + pendingOthers.length + unprocessedUnread.length;
              if (totalAttention === 0) return null;
              void pendingMsgIds;
              return (
                <button
                  onClick={() => setUnreadPanelOpen((o) => !o)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-sm font-medium hover:bg-indigo-100 transition-colors"
                >
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-500 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-600" />
                  </span>
                  {totalAttention} unread {totalAttention === 1 ? "message" : "messages"}
                  {pendingDrafts.length > 0 && (
                    <span
                      className="ml-1 px-1.5 py-0.5 rounded bg-indigo-600 text-white text-[10px] font-bold uppercase tracking-wide"
                      title={`${pendingDrafts.length} AI ${pendingDrafts.length === 1 ? "draft" : "drafts"} awaiting approval`}
                    >
                      {pendingDrafts.length} AI
                    </span>
                  )}
                  <svg
                    className={`w-3.5 h-3.5 transition-transform ${unreadPanelOpen ? "rotate-180" : ""}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              );
            })()}
          </div>

          {/* Early check-ins panel — expanded below pill row, full width */}
          {upcomingEarlyCheckins.length > 0 && earlyCheckinPanelOpen && (
            <div className="rounded-lg border border-teal-200 bg-teal-50 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-teal-200">
                    {["Reservation", "Guest", "Arrival date", "Request"].map((h) => (
                      <th key={h} className="px-4 py-2 text-xs font-medium text-teal-700 uppercase tracking-wide text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-teal-100">
                  {upcomingEarlyCheckins.map(({ reservation, issue, overdue }) => (
                    <tr
                      key={issue.id}
                      className={`cursor-pointer ${overdue ? "bg-teal-100/70 hover:bg-teal-200/60" : "hover:bg-teal-100"}`}
                      onClick={() => { setSelectedReservation(reservation); setEarlyCheckinPanelOpen(false); }}
                    >
                      <td className="px-4 py-2 font-mono text-xs text-teal-800 whitespace-nowrap">
                        {reservation.reservationNumber}
                      </td>
                      <td className="px-4 py-2 font-medium text-teal-900 whitespace-nowrap">
                        {reservation.firstName} {reservation.lastName}
                      </td>
                      <td className="px-4 py-2 text-teal-700 text-xs whitespace-nowrap">
                        {reservation.checkInDate || issue.actionableDate}
                      </td>
                      <td className="px-4 py-2 text-teal-700 max-w-md">
                        <div className="line-clamp-2">{issue.text}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Late checkouts panel — expanded below pill row, full width */}
          {upcomingLateCheckouts.length > 0 && lateCheckoutPanelOpen && (
            <div className="rounded-lg border border-orange-200 bg-orange-50 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-orange-200">
                    {["Reservation", "Guest", "Departure date", "Request"].map((h) => (
                      <th key={h} className="px-4 py-2 text-xs font-medium text-orange-700 uppercase tracking-wide text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-orange-100">
                  {upcomingLateCheckouts.map(({ reservation, issue, overdue }) => (
                    <tr
                      key={issue.id}
                      className={`cursor-pointer ${overdue ? "bg-orange-100/70 hover:bg-orange-200/60" : "hover:bg-orange-100"}`}
                      onClick={() => { setSelectedReservation(reservation); setLateCheckoutPanelOpen(false); }}
                    >
                      <td className="px-4 py-2 font-mono text-xs text-orange-800 whitespace-nowrap">
                        {reservation.reservationNumber}
                      </td>
                      <td className="px-4 py-2 font-medium text-orange-900 whitespace-nowrap">
                        {reservation.firstName} {reservation.lastName}
                      </td>
                      <td className="px-4 py-2 text-orange-700 text-xs whitespace-nowrap">
                        {reservation.checkOutDate || issue.actionableDate}
                      </td>
                      <td className="px-4 py-2 text-orange-700 max-w-md">
                        <div className="line-clamp-2">{issue.text}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Past-stay changes panel — reservations whose Beds24 record was
              modified AFTER the guest checked out. Most common cause: a
              channel re-import overwrote an operator's manual change to
              dates/price. Operator reviews, either accepts (acknowledge)
              or re-applies the change in Beds24. */}
          {postStayChanges.length > 0 && postStayPanelOpen && (
            <div className="rounded-lg border border-purple-200 bg-purple-50 overflow-hidden">
              <div className="px-4 py-2 bg-purple-100/60 border-b border-purple-200 flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-purple-900">
                  Past-stay modifications
                </span>
                <span className="text-[11px] text-purple-700">
                  Beds24 reported a change after checkout · review then acknowledge
                </span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-purple-200">
                    {["Guest", "Room", "Checkout", "Modified at", "What changed", ""].map((h, i) => (
                      <th
                        key={i}
                        className="px-4 py-2 text-xs font-medium text-purple-700 uppercase tracking-wide text-left"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-purple-200">
                  {postStayChanges.map((r) => {
                    const pending = ackingPostStayId === r.reservationNumber;
                    const diffs = computePostStayDiff(r);
                    return (
                      <tr
                        key={r.reservationNumber}
                        className="hover:bg-purple-100/60 cursor-pointer"
                        onClick={() => { setSelectedReservation(r); setPostStayPanelOpen(false); }}
                      >
                        <td className="px-4 py-2 font-medium text-purple-900 whitespace-nowrap">
                          {r.firstName} {r.lastName}
                        </td>
                        <td className="px-4 py-2 text-purple-800 whitespace-nowrap">{r.room}</td>
                        <td className="px-4 py-2 text-purple-700 text-xs whitespace-nowrap">{r.checkOutDate}</td>
                        <td className="px-4 py-2 text-purple-700 text-xs whitespace-nowrap">
                          {r.modifiedAt ? r.modifiedAt.slice(0, 16).replace('T', ' ') : '—'}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {/* Diff column behaviour:
                              - No snapshot yet → first-time detection. Show
                                "Set baseline" hint; acknowledging captures
                                the snapshot for future comparisons.
                              - Snapshot exists but no diff → Beds24 bumped
                                modifiedAt without changing tracked fields
                                (often happens on price-list re-sync that
                                touches internal flags only).
                              - Snapshot + diffs → enumerate them as
                                "Field: was → now" pairs. */}
                          {!r.postStaySnapshot ? (
                            <span className="italic text-purple-500">
                              No baseline yet — ack to set one for future changes
                            </span>
                          ) : diffs.length === 0 ? (
                            <span className="italic text-purple-500">
                              Touched but no tracked field changed
                            </span>
                          ) : (
                            <div className="flex flex-col gap-0.5 text-purple-900">
                              {diffs.map((d, i) => (
                                <span key={i} className="whitespace-nowrap">{d}</span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right whitespace-nowrap align-top">
                          <button
                            onClick={(e) => { e.stopPropagation(); acknowledgePostStayChange(r); }}
                            disabled={pending || ackingPostStayId !== null}
                            title="Mark as reviewed and snapshot current state — drops out of this list"
                            className="px-2.5 py-1 rounded-md border border-purple-300 bg-white text-purple-700 text-xs font-medium hover:bg-purple-100 disabled:opacity-40 transition-colors"
                          >
                            {pending ? 'Saving…' : 'Acknowledge'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Active blackouts panel — only PROSPECTIVE ones (still blocking
              future dates). Each row has an inline Remove button that calls
              the override-clear endpoint and refetches. Operator can also
              open the drawer (click row) to get the full blackout details. */}
          {activeBlackouts.length > 0 && blackoutsPanelOpen && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 overflow-hidden">
              <div className="px-4 py-2 bg-rose-100/60 border-b border-rose-200 flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-rose-900">
                  Active blackouts
                </span>
                <span className="text-[11px] text-rose-700">
                  Showing only blackouts still blocking future dates · {activeBlackouts.length} total
                </span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-rose-200">
                    {["Room", "From", "To", "Nights", ""].map((h, i) => (
                      <th
                        key={i}
                        className="px-4 py-2 text-xs font-medium text-rose-700 uppercase tracking-wide text-left"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rose-200">
                  {activeBlackouts.map((b) => {
                    const pending = removingBlackoutId === b.reservationNumber;
                    return (
                      <tr
                        key={b.reservationNumber}
                        className="hover:bg-rose-100/70 cursor-pointer"
                        onClick={() => { setSelectedReservation(b); setBlackoutsPanelOpen(false); }}
                      >
                        <td className="px-4 py-2 font-medium text-rose-900 whitespace-nowrap">{b.room}</td>
                        <td className="px-4 py-2 text-rose-700 text-xs whitespace-nowrap">{b.checkInDate}</td>
                        <td className="px-4 py-2 text-rose-700 text-xs whitespace-nowrap">{b.checkOutDate}</td>
                        <td className="px-4 py-2 text-rose-700 text-xs whitespace-nowrap">{b.numberOfNights}</td>
                        <td className="px-4 py-2 text-right whitespace-nowrap">
                          <button
                            // Stop the row click from also firing — operator
                            // wants to remove, not open the drawer.
                            onClick={(e) => { e.stopPropagation(); removeBlackout(b.reservationNumber); }}
                            disabled={pending || removingBlackoutId !== null}
                            className="px-2.5 py-1 rounded-md bg-rose-600 text-white text-xs font-medium hover:bg-rose-700 disabled:opacity-40 transition-colors"
                          >
                            {pending ? 'Removing…' : 'Remove'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Unallocated VR panel — each booking shows the fewest-move plan to
              give it a physical unit within its room type. Operator approves +
              executes in-app, or opens the drawer to handle manually. */}
          {unallocatedReservations.length > 0 && unallocatedPanelOpen && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 overflow-hidden">
              <div className="px-4 py-2 bg-amber-100/60 border-b border-amber-300 flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                  Room assignment needed
                </span>
                <span className="text-[11px] text-amber-700">
                  Beds24 couldn&apos;t auto-allocate · review the suggested move, then approve — or open to handle manually
                </span>
              </div>
              <div className="divide-y divide-amber-200">
                {unallocatedReservations.map((r) => {
                  const result = unallocatedPlans[r.reservationNumber];
                  const busy = resolveBusy === r.reservationNumber;
                  const err = resolveError[r.reservationNumber];
                  const canDo = Boolean(role && canMutate(role, "transactions"));
                  return (
                    <div key={r.reservationNumber} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-amber-900">
                            {r.firstName} {r.lastName}
                            <span className="ml-2 text-[11px] font-normal text-amber-700">{r.room}</span>
                          </p>
                          <p className="text-xs text-amber-700 mt-0.5">
                            {r.checkInDate} → {r.checkOutDate} · {r.numberOfNights}n · {r.channel} ·{" "}
                            <span className="font-mono">{r.reservationNumber}</span>
                          </p>
                        </div>
                        <button
                          onClick={() => { setSelectedReservation(r); setUnallocatedPanelOpen(false); }}
                          className="text-[11px] text-amber-700 hover:text-amber-900 underline shrink-0"
                        >
                          Open
                        </button>
                      </div>

                      <div className="mt-2">
                        {!result || "error" in result ? (
                          <p className="text-xs text-amber-700 italic">
                            {result && "error" in result ? result.error : "—"}
                          </p>
                        ) : !result.plan.feasible ? (
                          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5">
                            {result.plan.reason ?? "Can't resolve within this room type — handle manually."}
                          </div>
                        ) : (
                          <div className="rounded-md bg-white border border-amber-200 px-3 py-2">
                            <p className="text-xs font-medium text-emerald-800">
                              {result.plan.placements.map((p) => `Assign to ${p.room}`).join(", ")}
                              {result.plan.moves.length === 0 && " — no other moves needed"}
                            </p>
                            {result.plan.moves.length > 0 && (
                              <ul className="mt-1 space-y-0.5">
                                {result.plan.moves.map((m) => (
                                  <li key={m.reservationNumber} className="text-[11px] text-amber-800">
                                    ↪ Move <span className="font-medium">{m.label ?? m.reservationNumber}</span>{" "}
                                    {m.from} → {m.to}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                onClick={() => executeReallocation(r.reservationNumber)}
                                disabled={busy || !canDo}
                                className="text-xs px-3 py-1.5 rounded bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                title={canDo ? "Apply this allocation in Beds24" : "Insufficient permissions"}
                              >
                                {busy
                                  ? "Applying…"
                                  : result.plan.moves.length === 0
                                    ? `Assign ${result.plan.placements[0]?.room ?? ""}`
                                    : `Approve & execute · ${result.plan.moves.length} move${result.plan.moves.length > 1 ? "s" : ""}`}
                              </button>
                              <span className="text-[10.5px] text-amber-600">within {result.group.typeLabel}</span>
                            </div>
                          </div>
                        )}
                        {err && <p className="mt-1 text-xs text-rose-700">{err}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Pending-tasks panel — expanded below the pill row, full width.
              Container theme follows the pill: red when overdue items exist,
              amber when everything's upcoming. Individual rows are then
              further differentiated — overdue rows always render red
              regardless of overall theme, upcoming rows render amber. */}
          {upcomingUnresolved.length > 0 && taskAlertOpen && (
            <div
              className={`rounded-lg border overflow-hidden ${
                overdueCount > 0
                  ? 'border-red-200 bg-red-50'
                  : 'border-amber-200 bg-amber-50'
              }`}
            >
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className={`border-b ${overdueCount > 0 ? 'border-red-200' : 'border-amber-200'}`}
                  >
                    {["Guest", "Type", "Task / Issue", "Date"].map((h) => (
                      <th
                        key={h}
                        className={`px-4 py-2 text-xs font-medium uppercase tracking-wide text-left ${
                          overdueCount > 0 ? 'text-red-700' : 'text-amber-700'
                        }`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody
                  className={`divide-y ${overdueCount > 0 ? 'divide-red-100' : 'divide-amber-100'}`}
                >
                  {upcomingUnresolved.map(({ reservation, issue, overdue }) => {
                    const cat = (issue.category ?? "problem") as IssueCategory;
                    const catLabels: Record<IssueCategory, string> = {
                      problem: "Problem",
                      invoice: "Send Invoice",
                      cleaning: "Mid-stay Cleaning",
                      special: "Special Treatment",
                      earlyCheckin: "Early Check-in Request",
                      lateCheckout: "Late Checkout Request",
                    };
                    const todayMs = new Date(new Date().toLocaleDateString("sv-SE") + "T00:00:00").getTime();
                    const dueMs = new Date(issue.actionableDate + "T00:00:00").getTime();
                    const daysLate = Math.round((todayMs - dueMs) / 86_400_000);
                    // Per-row classes: overdue rows render red regardless of
                    // overall panel theme so they stand out even in an
                    // otherwise-calm (amber) view; upcoming rows render amber.
                    const rowBg = overdue
                      ? 'bg-red-100/70 hover:bg-red-200/60'
                      : 'hover:bg-amber-100';
                    const textName = overdue ? 'text-red-900' : 'text-amber-900';
                    const textMuted = overdue ? 'text-red-600' : 'text-amber-700';
                    const textBody = overdue ? 'text-red-700' : 'text-amber-800';
                    return (
                      <tr
                        key={issue.id}
                        className={`cursor-pointer ${rowBg}`}
                        onClick={() => { setSelectedReservation(reservation); setTaskAlertOpen(false); }}
                      >
                        <td className={`px-4 py-2 font-medium whitespace-nowrap ${textName}`}>
                          {reservation.firstName} {reservation.lastName}
                        </td>
                        <td className={`px-4 py-2 text-xs whitespace-nowrap ${textMuted}`}>{catLabels[cat]}</td>
                        <td className={`px-4 py-2 ${textBody}`}>{issue.text}</td>
                        <td className={`px-4 py-2 text-xs whitespace-nowrap ${textMuted}`}>
                          <div className="flex items-center gap-1.5">
                            <span>{issue.actionableDate}</span>
                            {overdue && (
                              <span
                                className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[9px] font-bold uppercase tracking-wide"
                                title={`Was due ${daysLate} day${daysLate === 1 ? "" : "s"} ago`}
                              >
                                {daysLate === 0 ? "Overdue" : `${daysLate}d overdue`}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Unread-messages panel — restructured into two sections plus a
              legacy fallback for any unread booking not yet picked up by
              the auto-reply pipeline. */}
          {unreadPanelOpen && (pendingDrafts.length > 0 || pendingOthers.length > 0 || unreadBookings.length > 0) && (
            <div className="space-y-3">
              {/* ── Section A: AI drafts pending approval ── */}
              {pendingDrafts.length > 0 && (
                <div className="rounded-lg border border-violet-200 bg-violet-50/60 overflow-hidden">
                  <div className="px-4 py-2 bg-violet-100/60 border-b border-violet-200 flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-violet-800">
                      AI response pending approval
                    </span>
                    <span className="text-[11px] text-violet-600">
                      {pendingDrafts.length} {pendingDrafts.length === 1 ? "draft" : "drafts"} — review, edit if needed, then send
                    </span>
                  </div>
                  <div className="divide-y divide-violet-100">
                    {pendingDrafts.map((d) => {
                      const matching = reservations.find((r) => r.reservationNumber === d.reservationNumber);
                      const guestName = matching
                        ? `${matching.firstName} ${matching.lastName}`.trim()
                        : d.reservationNumber;
                      const room = matching?.room ?? "—";
                      const editedText = draftEdits[d.beds24MessageId] ?? d.draftText;
                      const busy = draftBusy[d.beds24MessageId];
                      return (
                        <div key={d.beds24MessageId} className="px-4 py-3">
                          <div className="flex items-center justify-between gap-3 mb-2">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="font-medium text-violet-900">{guestName}</span>
                              <span className="text-violet-600">·</span>
                              <span className="text-violet-700">{room}</span>
                              <span className="text-violet-600">·</span>
                              <span className="px-1.5 py-0.5 rounded bg-white ring-1 ring-violet-200 text-violet-700 font-medium uppercase tracking-wide text-[10px]">
                                {d.category}
                              </span>
                              {d.language && (
                                <>
                                  <span className="text-violet-600">·</span>
                                  <span className="text-violet-600 text-[11px]">{d.language}</span>
                                </>
                              )}
                            </div>
                            {matching && (
                              <button
                                onClick={() => { setSelectedReservation(matching); }}
                                className="text-[11px] text-violet-700 hover:text-violet-900 underline"
                              >
                                Open thread
                              </button>
                            )}
                          </div>
                          <div className="text-[13px] text-violet-900 mb-1 italic">
                            <span className="text-violet-600 not-italic font-medium mr-1">Guest:</span>
                            {d.guestMessageText}
                          </div>
                          <PanelCzech entry={panelTx[`${d.beds24MessageId}:guest`]} tone="violet" />
                          <textarea
                            value={editedText}
                            onChange={(e) =>
                              setDraftEdits((prev) => ({ ...prev, [d.beds24MessageId]: e.target.value }))
                            }
                            rows={Math.min(8, Math.max(3, editedText.split('\n').length + 1))}
                            className="w-full text-sm bg-white border border-violet-200 rounded p-2 text-violet-900 focus:outline-none focus:ring-2 focus:ring-violet-300"
                            disabled={Boolean(busy)}
                          />
                          <PanelCzech
                            entry={panelTx[`${d.beds24MessageId}:draft`]}
                            tone="violet"
                            onRefresh={() => translatePanel(`${d.beds24MessageId}:draft`, editedText)}
                          />
                          {d.draftLanguage === 'cs' && d.targetLanguage && d.targetLanguage.toLowerCase() !== 'cs' && (
                            <div className="mt-1">
                              <span className="text-[11px] text-violet-500">You edit in Czech; sent in {langLabel(d.targetLanguage)}. </span>
                              <button
                                type="button"
                                onClick={() => previewTranslation(d.beds24MessageId, editedText, d.targetLanguage as string)}
                                disabled={!editedText.trim() || previewTx[d.beds24MessageId] === 'loading'}
                                className="text-[11px] text-violet-600 hover:text-violet-800 underline disabled:opacity-50 disabled:no-underline"
                              >
                                👁 Show translation
                              </button>
                              {previewTx[d.beds24MessageId] === 'loading' && (
                                <span className="text-[11px] italic text-violet-400 ml-2">Překládám…</span>
                              )}
                              {previewTx[d.beds24MessageId] === 'error' && (
                                <span className="text-[11px] italic text-violet-400 ml-2">Překlad se nepodařil</span>
                              )}
                              {(() => {
                                const p = previewTx[d.beds24MessageId];
                                if (!p || typeof p !== 'object') return null;
                                const stale = p.czech !== editedText;
                                return (
                                  <div className="text-[12px] mt-1 rounded px-2 py-1 ring-1 bg-violet-100/50 text-violet-800 ring-violet-200">
                                    <div className="text-[10px] uppercase tracking-wide text-violet-500 mb-0.5">
                                      Will be sent — {langLabel(d.targetLanguage as string)}
                                      {stale ? ' · edited since; click Show translation again' : ''}
                                    </div>
                                    <div className="whitespace-pre-wrap">{p.translated}</div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                          <div className="mt-2 flex items-center gap-2 justify-end">
                            <button
                              onClick={() => dismissDraft(d.beds24MessageId)}
                              disabled={Boolean(busy) || !role || !canMutate(role, "transactions")}
                              className="text-xs px-3 py-1.5 rounded bg-white border border-slate-300 text-slate-700 font-medium hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {busy === 'dismissing' ? 'Dismissing…' : 'Dismiss'}
                            </button>
                            <button
                              onClick={() => {
                                const p = previewTx[d.beds24MessageId];
                                const sendChecked =
                                  d.draftLanguage === 'cs' &&
                                  !!d.targetLanguage &&
                                  d.targetLanguage.toLowerCase() !== 'cs' &&
                                  !!p &&
                                  typeof p === 'object' &&
                                  p.czech === editedText;
                                if (sendChecked) {
                                  approveDraft(d.beds24MessageId, (p as { translated: string }).translated, true, editedText);
                                } else {
                                  approveDraft(d.beds24MessageId, editedText, false, editedText);
                                }
                              }}
                              disabled={Boolean(busy) || !editedText.trim() || !role || !canMutate(role, "transactions")}
                              className="text-xs px-3 py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
                            >
                              {busy === 'sending'
                                ? 'Sending…'
                                : editedText.trim() === d.draftText.trim()
                                  ? 'Approve & send'
                                  : 'Send edited reply'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Section B: Unread `other` messages — operator handles ── */}
              {pendingOthers.length > 0 && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 overflow-hidden">
                  <div className="px-4 py-2 bg-indigo-100/60 border-b border-indigo-200 flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-indigo-800">
                      Unread messages
                    </span>
                    <span className="text-[11px] text-indigo-600">
                      {pendingOthers.length} {pendingOthers.length === 1 ? "message" : "messages"} for the operator to handle
                    </span>
                  </div>
                  <div className="divide-y divide-indigo-100">
                    {pendingOthers.map((o) => {
                      const matching = reservations.find((r) => r.reservationNumber === o.reservationNumber);
                      const guestName = matching
                        ? `${matching.firstName} ${matching.lastName}`.trim()
                        : o.reservationNumber;
                      const room = matching?.room ?? "—";
                      const hasDraft = Boolean(o.draftText);
                      const editedText = draftEdits[o.beds24MessageId] ?? o.draftText;
                      const busy = draftBusy[o.beds24MessageId];
                      return (
                        <div key={o.beds24MessageId} className="px-4 py-3">
                          <div className="flex items-center justify-between gap-3 mb-2">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="font-medium text-indigo-900">{guestName}</span>
                              <span className="text-indigo-600">·</span>
                              <span className="text-indigo-700">{room}</span>
                              {o.language && (
                                <>
                                  <span className="text-indigo-600">·</span>
                                  <span className="text-indigo-600 text-[11px]">{o.language}</span>
                                </>
                              )}
                            </div>
                            {matching && (
                              <button
                                onClick={() => { setSelectedReservation(matching); }}
                                className="text-[11px] text-indigo-700 hover:text-indigo-900 underline"
                              >
                                Open thread
                              </button>
                            )}
                          </div>
                          <div className="text-[13px] text-indigo-900 mb-1 italic">
                            <span className="text-indigo-600 not-italic font-medium mr-1">Guest:</span>
                            {o.guestMessageText}
                          </div>
                          <PanelCzech entry={panelTx[`${o.beds24MessageId}:guest`]} tone="indigo" />
                          {hasDraft ? (
                            <>
                              <div className="text-[10px] text-indigo-600 uppercase tracking-wide mb-1">
                                Suggested starting point (AI)
                              </div>
                              <textarea
                                value={editedText}
                                onChange={(e) =>
                                  setDraftEdits((prev) => ({ ...prev, [o.beds24MessageId]: e.target.value }))
                                }
                                rows={Math.min(8, Math.max(3, editedText.split('\n').length + 1))}
                                className="w-full text-sm bg-white border border-indigo-200 rounded p-2 text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                disabled={Boolean(busy)}
                              />
                              <PanelCzech
                                entry={panelTx[`${o.beds24MessageId}:draft`]}
                                tone="indigo"
                                onRefresh={() => translatePanel(`${o.beds24MessageId}:draft`, editedText)}
                              />
                            </>
                          ) : (
                            <textarea
                              value={draftEdits[o.beds24MessageId] ?? ''}
                              onChange={(e) =>
                                setDraftEdits((prev) => ({ ...prev, [o.beds24MessageId]: e.target.value }))
                              }
                              placeholder="Type a reply…"
                              rows={3}
                              className="w-full text-sm bg-white border border-indigo-200 rounded p-2 text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                              disabled={Boolean(busy)}
                            />
                          )}
                          <div className="mt-2 flex items-center gap-2 justify-end">
                            <button
                              onClick={() => dismissDraft(o.beds24MessageId)}
                              disabled={Boolean(busy) || !role || !canMutate(role, "transactions")}
                              className="text-xs px-3 py-1.5 rounded bg-white border border-slate-300 text-slate-700 font-medium hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {busy === 'dismissing' ? 'Dismissing…' : 'Dismiss'}
                            </button>
                            <button
                              onClick={() => {
                                const text = draftEdits[o.beds24MessageId] ?? o.draftText ?? '';
                                approveDraft(o.beds24MessageId, text);
                              }}
                              disabled={
                                Boolean(busy) ||
                                !(draftEdits[o.beds24MessageId] ?? o.draftText ?? '').trim() ||
                                !role ||
                                !canMutate(role, "transactions")
                              }
                              className="text-xs px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                            >
                              {busy === 'sending' ? 'Sending…' : 'Send reply'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Fallback: unread bookings the auto-reply pipeline hasn't picked up yet ── */}
              {(() => {
                const pendingBookingIds = new Set<number>([
                  ...pendingDrafts.map((d) => d.bookingId),
                  ...pendingOthers.map((o) => o.bookingId),
                ]);
                const unprocessed = unreadBookings.filter((b) => !pendingBookingIds.has(b.bookingId));
                if (unprocessed.length === 0) return null;
                return (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 overflow-hidden">
                    <div className="px-4 py-2 bg-slate-100 border-b border-slate-200 flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                        Unprocessed unread
                      </span>
                      <span className="text-[11px] text-slate-500">
                        not yet picked up by the auto-reply pipeline
                      </span>
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200">
                          {["Guest", "Room", "Last message", "Activity"].map((h) => (
                            <th key={h} className="px-4 py-2 text-xs font-medium text-slate-600 uppercase tracking-wide text-left">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {unprocessed.map((u) => {
                          const matchingReservation = reservations.find(
                            (r) => r.reservationNumber === `BH-${u.bookingId}`,
                          );
                          const guestName = matchingReservation
                            ? `${matchingReservation.firstName} ${matchingReservation.lastName}`.trim()
                            : `BH-${u.bookingId}`;
                          const room = matchingReservation?.room ?? "—";
                          const arrivedMs = new Date(u.latestMessageTime).getTime();
                          const ageMin = Math.max(0, Math.round((Date.now() - arrivedMs) / 60_000));
                          const ageLabel =
                            ageMin < 1 ? "just now"
                            : ageMin < 60 ? `${ageMin} min ago`
                            : ageMin < 24 * 60 ? `${Math.round(ageMin / 60)}h ago`
                            : `${Math.round(ageMin / 60 / 24)}d ago`;
                          return (
                            <tr
                              key={u.bookingId}
                              className="cursor-pointer hover:bg-slate-100"
                              onClick={() => {
                                if (matchingReservation) {
                                  setSelectedReservation(matchingReservation);
                                  setUnreadPanelOpen(false);
                                }
                              }}
                            >
                              <td className="px-4 py-2 font-medium text-slate-800 whitespace-nowrap">{guestName}</td>
                              <td className="px-4 py-2 text-slate-600 text-xs whitespace-nowrap">{room}</td>
                              <td className="px-4 py-2 text-slate-700 max-w-md">
                                <div className="line-clamp-2">{u.latestMessage}</div>
                                {u.unreadCount > 1 && (
                                  <div className="text-[11px] text-slate-500 mt-0.5">
                                    +{u.unreadCount - 1} more unread
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-2 text-slate-500 text-xs whitespace-nowrap">{ageLabel}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Unpaid additional payments pill */}
      {unpaidAdditionalPayments.length > 0 && (
        <div className="mb-3">
          <button
            onClick={() => setPaymentAlertOpen((o) => !o)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium hover:bg-amber-100 transition-colors"
          >
            <svg className="w-3.5 h-3.5 shrink-0 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {unpaidAdditionalPayments.length} unpaid additional {unpaidAdditionalPayments.length === 1 ? "payment" : "payments"}
            <svg
              className={`w-3.5 h-3.5 transition-transform ${paymentAlertOpen ? "rotate-180" : ""}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {paymentAlertOpen && (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-amber-200">
                    {["Guest", "Reservation", "Description", "Amount", "Sent"].map((h) => (
                      <th key={h} className="px-4 py-2 text-xs font-medium text-amber-700 uppercase tracking-wide text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100">
                  {unpaidAdditionalPayments.map(({ reservation, payment }) => (
                    <tr
                      key={payment.id}
                      className="hover:bg-amber-100 cursor-pointer"
                      onClick={() => { setSelectedReservation(reservation); setPaymentAlertOpen(false); }}
                    >
                      <td className="px-4 py-2 font-medium text-amber-900 whitespace-nowrap">
                        {reservation.firstName} {reservation.lastName}
                      </td>
                      <td className="px-4 py-2 text-amber-700 text-xs whitespace-nowrap">{payment.reservationNumber}</td>
                      <td className="px-4 py-2 text-amber-700">{payment.description}</td>
                      <td className="px-4 py-2 text-amber-900 font-medium whitespace-nowrap">
                        {payment.amountCzk.toLocaleString("cs-CZ")} Kč
                      </td>
                      <td className="px-4 py-2 text-amber-600 text-xs whitespace-nowrap">
                        {payment.createdAt.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Search + Filters */}
      <div className="space-y-3 mb-5">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by reservation #, guest name, or email..."
          className="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white shadow-sm"
        />
        <FilterPanel filters={filters} onChange={setFilters} />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : (
        <ReservationTable
          reservations={filtered}
          allReservations={reservations}
          unreadBookingIds={unreadBookingIds}
          onRowClick={setSelectedReservation}
        />
      )}

      {/* Drawer */}
      <ReservationDrawer
        reservation={selectedReservation}
        allReservations={reservations}
        unreadBookingIds={unreadBookingIds}
        onClose={() => setSelectedReservation(null)}
        onUpdate={handleUpdate}
        onPaymentCreated={fetchReservations}
        saveStatus={saveStatus}
      />

      {/* Create booking modal */}
      {showCreateModal && (
        <CreateBookingModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            fetchReservations({ fullSync: true });
          }}
        />
      )}

      {/* Blackout modal — close a room for a date range without a reservation */}
      {showBlackoutModal && (
        <BlackoutModal
          onClose={() => setShowBlackoutModal(false)}
          onCreated={() => {
            setShowBlackoutModal(false);
            fetchReservations();
          }}
        />
      )}

      {/* Manual payment link modal */}
      {showPaymentModal && (
        <PaymentLinkModal
          reservations={reservations.map((r) => ({
            reservationNumber: r.reservationNumber,
            guestName: [r.firstName, r.lastName].filter(Boolean).join(' '),
            email: r.additionalEmail || r.invoiceData?.billingEmail || undefined,
            phone: r.phone,
            checkIn: r.checkInDate,
            checkOut: r.checkOutDate,
          }))}
          onPaymentCreated={fetchReservations}
          onClose={() => setShowPaymentModal(false)}
        />
      )}

      {/* Price check modal */}
      {showPriceCheck && (
        <PriceCheckModal onClose={() => setShowPriceCheck(false)} />
      )}

      {/* Create voucher modal */}
      {showVoucherModal && (
        <CreateVoucherModal
          reservations={reservations.map((r) => ({
            reservationNumber: r.reservationNumber,
            guestName: [r.firstName, r.lastName].filter(Boolean).join(' '),
            email: r.additionalEmail || r.invoiceData?.billingEmail || undefined,
            phone: r.phone,
            checkIn: r.checkInDate,
            checkOut: r.checkOutDate,
          }))}
          onVoucherCreated={fetchReservations}
          onClose={() => setShowVoucherModal(false)}
        />
      )}
    </div>
  );
}
