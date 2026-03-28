'use client';
import { useState } from "react";
import type {
  Channel,
  Room,
  CleaningStatus,
  PaymentStatus,
  CustomerFlag,
} from "@/types/reservation";

export interface Filters {
  channels: Channel[];
  rooms: Room[];
  checkInFrom: string;
  checkInTo: string;
  cleaningStatuses: CleaningStatus[];
  paymentStatuses: PaymentStatus[];
  customerFlags: CustomerFlag[];
}

export const defaultFilters: Filters = {
  channels: [],
  rooms: [],
  checkInFrom: "",
  checkInTo: "",
  cleaningStatuses: [],
  paymentStatuses: [],
  customerFlags: [],
};

interface FilterPanelProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

function MultiCheckbox<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: T[];
  selected: T[];
  onChange: (v: T[]) => void;
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
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function FilterPanel({ filters, onChange }: FilterPanelProps) {
  const [open, setOpen] = useState(false);

  const channels: Channel[] = ["Booking.com", "Airbnb", "Direct"];
  const rooms: Room[] = ["Apartment 101", "Apartment 202", "Apartment 303"];
  const cleaningStatuses: CleaningStatus[] = [
    "Pending",
    "In Progress",
    "Completed",
  ];
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

  const hasFilters =
    filters.channels.length > 0 ||
    filters.rooms.length > 0 ||
    filters.checkInFrom ||
    filters.checkInTo ||
    filters.cleaningStatuses.length > 0 ||
    filters.paymentStatuses.length > 0 ||
    filters.customerFlags.length > 0;

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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4 pt-4">
            <MultiCheckbox
              label="Channel"
              options={channels}
              selected={filters.channels}
              onChange={(v) => onChange({ ...filters, channels: v })}
            />
            <MultiCheckbox
              label="Room"
              options={rooms}
              selected={filters.rooms}
              onChange={(v) => onChange({ ...filters, rooms: v })}
            />
            <MultiCheckbox
              label="Cleaning Status"
              options={cleaningStatuses}
              selected={filters.cleaningStatuses}
              onChange={(v) => onChange({ ...filters, cleaningStatuses: v })}
            />
            <MultiCheckbox
              label="Payment Status"
              options={paymentStatuses}
              selected={filters.paymentStatuses}
              onChange={(v) => onChange({ ...filters, paymentStatuses: v })}
            />
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                Check-in From
              </p>
              <input
                type="date"
                value={filters.checkInFrom}
                onChange={(e) =>
                  onChange({ ...filters, checkInFrom: e.target.value })
                }
                className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                Check-in To
              </p>
              <input
                type="date"
                value={filters.checkInTo}
                onChange={(e) =>
                  onChange({ ...filters, checkInTo: e.target.value })
                }
                className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="lg:col-span-2">
              <MultiCheckbox
                label="Customer Flags"
                options={customerFlags}
                selected={filters.customerFlags}
                onChange={(v) => onChange({ ...filters, customerFlags: v })}
              />
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
