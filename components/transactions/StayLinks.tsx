"use client";

/**
 * Stay links in the Transactions UI — one guest's stay booked as several
 * back-to-back reservations (a prolongation sold as a separate direct
 * booking, an early-arrival night, …). Logic lives in utils/stayChains.ts;
 * this file only renders it:
 *   - `StayLinkBadge`: the 🔗 next to a reservation number in the table;
 *   - `StayLinkSection`: the drawer block — the stay summary with Unlink, the
 *     back-to-back bookings that could be linked, and "not the same guest".
 * Writes go through the parent (`onAction`), which stores the link on the
 * LATER booking's overrides.
 */

import { useMemo, useState } from "react";
import type { Reservation } from "@/types/reservation";
import { formatCurrency, formatDate } from "@/utils/formatters";
import {
  confirmedLinks,
  isRejectedPair,
  stayChainIndex,
  staySuggestions,
  type StayChain,
  type StaySignal,
} from "@/utils/stayChains";
import { pragueDateOf } from "@/utils/stayLinkCleanings";

export type StayLinkAction = "link" | "unlink" | "reject" | "unreject";

const SIGNAL_LABEL: Record<StaySignal, string> = { name: "name", email: "email", phone: "phone" };

export function signalsText(signals: StaySignal[]): string {
  return signals.map((s) => SIGNAL_LABEL[s]).join(" + ");
}

function nightsLabel(n: number): string {
  return `${n} ${n === 1 ? "night" : "nights"}`;
}

/** Tooltip text for a linked stay. */
export function stayTitle(chain: StayChain<Reservation>): string {
  return (
    `One stay: ${formatDate(chain.checkInDate)} → ${formatDate(chain.checkOutDate)} (${nightsLabel(chain.nights)})\n` +
    chain.members.map((m) => `${m.reservationNumber} · ${m.channel} · ${m.room} · ${nightsLabel(m.numberOfNights)}`).join("\n")
  );
}

export function StayLinkBadge({ chain }: { chain: StayChain<Reservation> | undefined }) {
  if (!chain) return null;
  return (
    <span
      title={stayTitle(chain)}
      className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-teal-50 text-teal-700 border border-teal-200 not-italic"
    >
      🔗 {chain.nights} n
    </span>
  );
}

const isLive = (r: Reservation) => !r.isCancelled && !r.isBlackout;

interface Candidate {
  earlier: Reservation;
  later: Reservation;
  other: Reservation;
  signals: StaySignal[];
  rejected: boolean;
  canLink: boolean;
}

export function StayLinkSection({
  reservation,
  allReservations,
  canEdit,
  onAction,
  onOpen,
}: {
  reservation: Reservation;
  allReservations: Reservation[];
  canEdit: boolean;
  onAction: (earlier: Reservation, later: Reservation, action: StayLinkAction) => Promise<void>;
  onOpen?: (r: Reservation) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualNumber, setManualNumber] = useState("");

  const prevOf = useMemo(() => confirmedLinks(allReservations), [allReservations]);
  const chain = useMemo(
    () => stayChainIndex(allReservations).get(reservation.reservationNumber),
    [allReservations, reservation.reservationNumber],
  );

  // Every live booking that meets this one — the only ones a link can join.
  const { candidates, neighbours } = useMemo(() => {
    const continued = new Set(prevOf.values());
    const neighbours: { earlier: Reservation; later: Reservation; other: Reservation }[] = [];
    if (isLive(reservation)) {
      for (const x of allReservations) {
        if (x === reservation || !isLive(x)) continue;
        if (x.checkOutDate === reservation.checkInDate) neighbours.push({ earlier: x, later: reservation, other: x });
        else if (x.checkInDate === reservation.checkOutDate) neighbours.push({ earlier: reservation, later: x, other: x });
      }
    }
    const candidates: Candidate[] = [];
    for (const n of neighbours) {
      if (prevOf.get(n.later.reservationNumber) === n.earlier.reservationNumber) continue; // already linked
      const rejected = isRejectedPair(n.earlier, n.later);
      // Signals regardless of date (the drawer also serves past stays).
      const signals = rejected ? [] : staySuggestions([n.earlier, n.later], "0000-00-00")[0]?.signals ?? [];
      // Only bookings that look like the same guest. Same-unit turnovers between
      // strangers happen daily; offering those would invite a mis-click that
      // skips a real cleaning. Anything else is linked by typing its number.
      if (!rejected && signals.length === 0) continue;
      candidates.push({
        ...n,
        signals,
        rejected,
        canLink: !prevOf.has(n.later.reservationNumber) && !continued.has(n.earlier.reservationNumber),
      });
    }
    return { candidates, neighbours };
  }, [reservation, allReservations, prevOf]);

  if (!isLive(reservation) || (!chain && neighbours.length === 0)) return null;

  const run = async (key: string, earlier: Reservation, later: Reservation, action: StayLinkAction) => {
    setBusy(key);
    setError(null);
    try {
      await onAction(earlier, later, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const linkManual = async () => {
    const wanted = manualNumber.trim().toUpperCase().replace(/^(\d)/, "BH-$1");
    const n = neighbours.find((x) => x.other.reservationNumber.toUpperCase() === wanted);
    if (!n) {
      setError(`${wanted || "That booking"} doesn't meet this stay — it must check out the day this one arrives, or arrive the day it leaves.`);
      return;
    }
    if (prevOf.has(n.later.reservationNumber) || new Set(prevOf.values()).has(n.earlier.reservationNumber)) {
      setError("One of the two is already linked to another booking on that side — unlink that first.");
      return;
    }
    await run(`manual`, n.earlier, n.later, "link");
    setManualNumber("");
    setManualOpen(false);
  };

  const linkablePairs = chain ? chain.members.slice(1).map((later, i) => ({ earlier: chain.members[i], later })) : [];

  const manualForm = canEdit && (
    <div className="mt-2">
      {manualOpen ? (
        <div className="flex items-center gap-1.5">
          <input
            value={manualNumber}
            onChange={(e) => setManualNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") linkManual(); }}
            placeholder="BH-…"
            className="w-32 px-2 py-0.5 rounded border border-teal-300 bg-white font-mono text-xs"
          />
          <button
            onClick={linkManual}
            disabled={busy !== null || !manualNumber.trim()}
            className="px-2 py-0.5 rounded border border-teal-300 bg-white text-teal-800 text-xs font-medium hover:bg-teal-100 disabled:opacity-50"
          >
            {busy === "manual" ? "Linking…" : "Link"}
          </button>
          <button onClick={() => { setManualOpen(false); setError(null); }} className="text-[11px] text-gray-500 underline">
            Cancel
          </button>
        </div>
      ) : (
        <button onClick={() => setManualOpen(true)} className="text-[11px] text-teal-700 underline hover:text-teal-900">
          {chain || candidates.length > 0 ? "Link another back-to-back booking…" : "🔗 Link a prolongation booked separately…"}
        </button>
      )}
      {error && <p className="mt-1.5 text-[11px] text-red-700">{error}</p>}
    </div>
  );

  // Nothing linked or suggested: just the quiet manual entry point.
  if (!chain && candidates.length === 0) return manualForm || null;

  return (
    <div className="mt-3 rounded-lg border border-teal-200 bg-teal-50/50 px-3 py-2.5 text-xs">
      {chain ? (
        <>
          <p className="font-semibold text-teal-900">
            🔗 One stay · {formatDate(chain.checkInDate)} → {formatDate(chain.checkOutDate)} · {nightsLabel(chain.nights)}
          </p>
          <ul className="mt-1.5 space-y-1">
            {chain.members.map((m) => {
              const self = m.reservationNumber === reservation.reservationNumber;
              return (
                <li key={m.reservationNumber} className="flex items-center gap-2 text-teal-900">
                  {self || !onOpen ? (
                    <span className={`font-mono ${self ? "font-semibold" : ""}`}>{m.reservationNumber}</span>
                  ) : (
                    <button onClick={() => onOpen(m)} className="font-mono underline hover:text-teal-700">
                      {m.reservationNumber}
                    </button>
                  )}
                  <span className="text-teal-700">
                    {m.channel} · {m.room} · {formatDate(m.checkInDate)} → {formatDate(m.checkOutDate)} · {nightsLabel(m.numberOfNights)} · {formatCurrency(m.price)}
                  </span>
                </li>
              );
            })}
          </ul>
          {linkablePairs.map(({ earlier, later }) => {
            const linkedOn = later.stayLink?.linkedAt ? pragueDateOf(later.stayLink.linkedAt) : null;
            const moved = earlier.room !== later.room;
            const late = !moved && linkedOn !== null && linkedOn > earlier.checkOutDate;
            const key = `unlink:${later.reservationNumber}`;
            return (
              <div key={key} className="mt-1.5 flex items-start gap-2 text-[11px] text-teal-800">
                <span className="flex-1">
                  {formatDate(earlier.checkOutDate)}:{" "}
                  {moved
                    ? `the guest moves ${earlier.room} → ${later.room} — that day's cleaning of ${earlier.room} stays.`
                    : late
                      ? `linked after the handover, so the cleaning app kept that day's cleaning — remove it there if it didn't happen.`
                      : `no turnover cleaning — the guest stays on in ${earlier.room}.`}
                  {later.stayLink?.linkedBy && (
                    <span className="text-teal-600"> Linked by {later.stayLink.linkedBy}.</span>
                  )}
                </span>
                {canEdit && (
                  <button
                    onClick={() => run(key, earlier, later, "unlink")}
                    disabled={busy !== null}
                    className="shrink-0 px-2 py-0.5 rounded border border-teal-300 bg-white text-teal-800 font-medium hover:bg-teal-100 disabled:opacity-50"
                    title={`Unlink ${earlier.reservationNumber} and ${later.reservationNumber}`}
                  >
                    {busy === key ? "Unlinking…" : "Unlink"}
                  </button>
                )}
              </div>
            );
          })}
        </>
      ) : (
        <p className="font-semibold text-teal-900">🔗 Stay links</p>
      )}

      {candidates.length > 0 && (
        <ul className={`${chain ? "mt-2 pt-2 border-t border-teal-200" : "mt-1.5"} space-y-1.5`}>
          {candidates.map((c) => {
            const key = `${c.earlier.reservationNumber}>${c.later.reservationNumber}`;
            const before = c.other === c.earlier;
            return (
              <li key={key} className="flex items-start gap-2">
                <span className="flex-1 text-teal-900">
                  {before ? "Arrives from" : "Continues as"}{" "}
                  {onOpen ? (
                    <button onClick={() => onOpen(c.other)} className="font-mono underline hover:text-teal-700">
                      {c.other.reservationNumber}
                    </button>
                  ) : (
                    <span className="font-mono">{c.other.reservationNumber}</span>
                  )}{" "}
                  <span className="text-teal-700">
                    · {c.other.firstName} {c.other.lastName} · {c.other.channel} · {c.other.room} ·{" "}
                    {formatDate(c.other.checkInDate)} → {formatDate(c.other.checkOutDate)}
                  </span>
                  {c.signals.length > 0 && (
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-teal-600">same {signalsText(c.signals)}</span>
                  )}
                  {c.rejected && (
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-gray-500">marked not the same guest</span>
                  )}
                </span>
                {canEdit && (
                  <span className="shrink-0 flex items-center gap-1.5">
                    {c.rejected ? (
                      <button
                        onClick={() => run(key, c.earlier, c.later, "unreject")}
                        disabled={busy !== null}
                        className="text-[11px] text-teal-700 underline hover:text-teal-900 disabled:opacity-50"
                      >
                        Undo
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => run(key, c.earlier, c.later, "link")}
                          disabled={busy !== null || !c.canLink}
                          title={c.canLink ? "Treat the two bookings as one stay" : "One of the two is already linked on that side"}
                          className="px-2 py-0.5 rounded border border-teal-300 bg-white text-teal-800 font-medium hover:bg-teal-100 disabled:opacity-50"
                        >
                          {busy === key ? "Linking…" : "Link as one stay"}
                        </button>
                        {c.signals.length > 0 && (
                          <button
                            onClick={() => run(key, c.earlier, c.later, "reject")}
                            disabled={busy !== null}
                            className="text-[11px] text-gray-500 underline hover:text-gray-700 disabled:opacity-50"
                          >
                            Not same guest
                          </button>
                        )}
                      </>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {manualForm}
    </div>
  );
}
