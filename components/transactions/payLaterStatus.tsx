"use client";

/**
 * Pay later in the Transactions list: a pay-later booking has deposit 0 in
 * Beds24, so its payment badge would read a red "Unpaid". This overlays
 * "Pay later" (scheduled) or "Pay failed" (declined, waiting for the guest or
 * the 2nd attempt) from the schedules, through a context so the table needs no
 * new props.
 */

import { createContext, useContext, useEffect, useState } from "react";
import type { WebPaymentStatus, WebPaymentView } from "@/types/webPayment";

export interface PayLaterBrief {
  status: WebPaymentStatus;
  /** Next charge time while open. */
  nextAt: string | null;
}

export const PayLaterStatusContext = createContext<Record<string, PayLaterBrief>>({});

/** Open schedules by reservation number — every row of a two-studio booking included. */
export function usePayLaterStatuses(refreshKey: unknown): Record<string, PayLaterBrief> {
  const [map, setMap] = useState<Record<string, PayLaterBrief>>({});
  useEffect(() => {
    let alive = true;
    fetch("/api/web-payments", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as { schedules: WebPaymentView[] };
        const next: Record<string, PayLaterBrief> = {};
        for (const s of json.schedules) {
          if (s.status !== "scheduled" && s.status !== "failed") continue;
          const brief = { status: s.status, nextAt: s.status === "scheduled" ? s.attempt1At : s.attempt2EffectiveAt };
          for (const id of s.bookingIds) next[`BH-${id}`] = brief;
        }
        if (alive) setMap(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return map;
}

/** The badge to show instead of "Unpaid", or null to keep the normal one. */
export function usePayLaterBadge(
  reservationNumber: string,
  effectivePayment: string,
): { label: string; variant: "blue" | "red"; title: string } | null {
  const brief = useContext(PayLaterStatusContext)[reservationNumber];
  if (!brief || effectivePayment !== "Unpaid") return null;
  const when = brief.nextAt
    ? new Date(brief.nextAt).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  return brief.status === "failed"
    ? { label: "Pay failed", variant: "red", title: `Pay later: the card was declined; 2nd attempt ${when}` }
    : { label: "Pay later", variant: "blue", title: `Pay later: the card is charged ${when}` };
}
