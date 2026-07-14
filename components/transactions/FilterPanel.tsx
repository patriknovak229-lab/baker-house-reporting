'use client';
import { useMemo, useState } from "react";
import type {
  Channel,
  Room,
  PaymentStatus,
  CustomerFlag,
  RatingStatus,
  RateType,
} from "@/types/reservation";
import { groupRoomsByCategory } from "@/utils/roomCategory";
import { RATE_TYPES, RATE_TYPE_LABELS } from "@/utils/rateType";

export interface Filters {
  channels: Channel[];
  rooms: Room[];
  checkInFrom: string;
  checkInTo: string;
  checkOutFrom: string;
  checkOutTo: string;
  paymentStatuses: PaymentStatus[];
  rateTypes: RateType[];
  customerFlags: CustomerFlag[];
  /** Guest-rating class: "good" 😊 / "bad" 😡 / "none" (unrated). */
  ratings: RatingStatus[];
  /** Only reservations checked out in the last 7 days, in-house, or upcoming. */
  activeOnly: boolean;
}

export const defaultFilters: Filters = {
  channels: [],
  rooms: [],
  checkInFrom: "",
  checkInTo: "",
  checkOutFrom: "",
  checkOutTo: "",
  paymentStatuses: [],
  rateTypes: [],
  customerFlags: [],
  ratings: [],
  activeOnly: false,
};

interface FilterPanelProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

// ─── Month shortcut helpers ───────────────────────────────────────────────────
/** First / last calendar day of a "YYYY-MM" month, as YYYY-MM-DD strings. */
function monthBounds(ym: string): { first: string; last: string } {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last of this
  return { first: `${ym}-01`, last: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

/** The month value the check-in range currently represents (blank if it's not a
 *  clean whole-month span — e.g. the operator hand-edited the dates). */
function currentMonthValue(f: Filters): string {
  if (!f.checkInFrom || !f.checkInTo || !f.checkInFrom.endsWith("-01")) return "";
  const ym = f.checkInFrom.slice(0, 7);
  const { first, last } = monthBounds(ym);
  return f.checkInFrom === first && f.checkInTo === last ? ym : "";
}

/** Initial filters on first load / refresh: show ACTIVE reservations only
 *  (checked out in the last 7 days, in-house, or upcoming) across ALL months —
 *  so new bookings for future-month dates show without switching the month.
 *  "Clear all filters" still resets to the empty `defaultFilters`. */
export function makeInitialFilters(): Filters {
  return { ...defaultFilters, activeOnly: true };
}

function MultiCheckbox<T extends string>({
  label,
  options,
  selected,
  onChange,
  labels,
}: {
  label: string;
  options: T[];
  selected: T[];
  onChange: (v: T[]) => void;
  /** Optional display text per option value (defaults to the value itself). */
  labels?: Partial<Record<T, string>>;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = selected.includes(opt);
          return (
            <button
              key={opt}
              onClick={() => onChange(toggle(selected, opt))}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                active
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
              }`}
            >
              {labels?.[opt] ?? opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A labelled From/To date pair stacked vertically in a single column. */
function DateRangeStacked({
  label,
  from,
  to,
  onFrom,
  onTo,
}: {
  label: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const inputCls =
    "w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500";
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
        {label}
      </p>
      <div className="space-y-1.5">
        <div>
          <label className="block text-[10px] text-gray-400 mb-0.5">From</label>
          <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-[10px] text-gray-400 mb-0.5">To</label>
          <input type="date" value={to} onChange={(e) => onTo(e.target.value)} className={inputCls} />
        </div>
      </div>
    </div>
  );
}

/** Room filter rendered as two clearly-separated category groups (Urban / Deluxe).
 *  Mirrors the calendar's grouping so the filter visually reflects the same taxonomy. */
function RoomFilterGrouped({
  selected,
  onChange,
}: {
  selected: Room[];
  onChange: (v: Room[]) => void;
}) {
  const groups = groupRoomsByCategory();
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
        Room
      </p>
      <div className="space-y-2">
        {groups.map((group) => (
          <div key={group.category}>
            <p
              className={`text-[10px] font-semibold uppercase tracking-wider mb-1 ${
                group.category === 'Urban' ? 'text-cyan-700' : 'text-amber-700'
              }`}
            >
              {group.category}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {group.rooms.map((opt) => {
                const room = opt as Room;
                const active = selected.includes(room);
                return (
                  <button
                    key={room}
                    onClick={() => onChange(toggle(selected, room))}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                      active
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    {room}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FilterPanel({ filters, onChange }: FilterPanelProps) {
  const [open, setOpen] = useState(false);

  const channels: Channel[] = ["Booking.com", "Airbnb", "Direct", "Direct-Phone", "Direct-Web"];
  const paymentStatuses: PaymentStatus[] = [
    "Unpaid",
    "Partially Paid",
    "Paid",
    "Refunded",
  ];
  const customerFlags: CustomerFlag[] = [
    "Repeat Customer",
    "High Value Customer",
    "Problematic Customer",
  ];
  const ratingOptions: RatingStatus[] = ["good", "bad", "none"];
  const ratingLabels: Record<RatingStatus, string> = {
    good: "😊 Good",
    bad: "😡 Bad",
    none: "Unrated",
  };

  // Month shortcut: 12 months back → 6 months ahead of the current month.
  const monthOptions = useMemo(() => {
    const now = new Date();
    const opts: { ym: string; label: string }[] = [];
    for (let i = -12; i <= 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      opts.push({ ym, label: d.toLocaleString("en-US", { month: "long", year: "numeric" }) });
    }
    return opts;
  }, []);
  const selectedMonth = currentMonthValue(filters);

  const hasFilters =
    filters.channels.length > 0 ||
    filters.rooms.length > 0 ||
    filters.checkInFrom ||
    filters.checkInTo ||
    filters.checkOutFrom ||
    filters.checkOutTo ||
    filters.paymentStatuses.length > 0 ||
    filters.rateTypes.length > 0 ||
    filters.customerFlags.length > 0 ||
    filters.ratings.length > 0 ||
    filters.activeOnly;

  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      {/* Header row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
      >
        <span className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
            />
          </svg>
          Filters
          {hasFilters && (
            <span className="bg-indigo-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              active
            </span>
          )}
        </span>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-100">
          {/* Active-only toggle — prominent, since it's the everyday view */}
          <div className="pt-4">
            <button
              role="switch"
              aria-checked={filters.activeOnly}
              onClick={() => onChange({ ...filters, activeOnly: !filters.activeOnly })}
              className="flex items-center gap-2.5 group"
            >
              <span
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                  filters.activeOnly ? "bg-indigo-600" : "bg-gray-300"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    filters.activeOnly ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </span>
              <span className="text-left">
                <span className="block text-sm font-medium text-gray-700">Active reservations only</span>
                <span className="block text-[10px] text-gray-400">
                  Checked out in the last 7 days, in-house, and upcoming
                </span>
              </span>
            </button>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4 pt-4">
            <MultiCheckbox
              label="Channel"
              options={channels}
              selected={filters.channels}
              onChange={(v) => onChange({ ...filters, channels: v })}
            />
            <RoomFilterGrouped
              selected={filters.rooms}
              onChange={(v) => onChange({ ...filters, rooms: v })}
            />
            <MultiCheckbox
              label="Payment Status"
              options={paymentStatuses}
              selected={filters.paymentStatuses}
              onChange={(v) => onChange({ ...filters, paymentStatuses: v })}
            />
            <MultiCheckbox
              label="Rate"
              options={RATE_TYPES}
              labels={RATE_TYPE_LABELS}
              selected={filters.rateTypes}
              onChange={(v) => onChange({ ...filters, rateTypes: v })}
            />
            <DateRangeStacked
              label="Check-in"
              from={filters.checkInFrom}
              to={filters.checkInTo}
              onFrom={(v) => onChange({ ...filters, checkInFrom: v })}
              onTo={(v) => onChange({ ...filters, checkInTo: v })}
            />
            <DateRangeStacked
              label="Check-out"
              from={filters.checkOutFrom}
              to={filters.checkOutTo}
              onFrom={(v) => onChange({ ...filters, checkOutFrom: v })}
              onTo={(v) => onChange({ ...filters, checkOutTo: v })}
            />
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                Month
              </p>
              <select
                value={selectedMonth}
                onChange={(e) => {
                  const ym = e.target.value;
                  if (!ym) {
                    onChange({ ...filters, checkInFrom: "", checkInTo: "" });
                  } else {
                    const { first, last } = monthBounds(ym);
                    onChange({ ...filters, checkInFrom: first, checkInTo: last });
                  }
                }}
                className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">— Any month —</option>
                {monthOptions.map((m) => (
                  <option key={m.ym} value={m.ym}>
                    {m.label}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-gray-400 mt-1">Sets the check-in range</p>
            </div>
            <div className="lg:col-span-2">
              <MultiCheckbox
                label="Customer Flags"
                options={customerFlags}
                selected={filters.customerFlags}
                onChange={(v) => onChange({ ...filters, customerFlags: v })}
              />
            </div>
            <div>
              <MultiCheckbox
                label="Rating"
                options={ratingOptions}
                labels={ratingLabels}
                selected={filters.ratings}
                onChange={(v) => onChange({ ...filters, ratings: v })}
              />
              <p className="text-[10px] text-gray-400 mt-1">Good + Bad = all rated</p>
            </div>
          </div>

          {hasFilters && (
            <button
              onClick={() => onChange(defaultFilters)}
              className="mt-4 text-xs text-indigo-600 hover:underline"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
