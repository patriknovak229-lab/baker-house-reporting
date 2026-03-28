'use client';
import { PERIOD_OPTIONS } from "@/utils/periodUtils";
import type { PeriodKey, DateRange } from "@/utils/periodUtils";

interface Props {
  selected: PeriodKey;
  onChange: (period: PeriodKey) => void;
  customRange: DateRange;
  onCustomRangeChange: (range: DateRange) => void;
}

export default function PeriodSelector({
  selected,
  onChange,
  customRange,
  onCustomRangeChange,
}: Props) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {PERIOD_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => onChange(opt.key)}
            className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
              selected === opt.key
                ? "bg-indigo-600 text-white shadow-sm"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {selected === "custom" && (
        <div className="flex items-center gap-2 mt-3">
          <input
            type="date"
            value={customRange.start}
            onChange={(e) =>
              onCustomRangeChange({ ...customRange, start: e.target.value })
            }
            className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <span className="text-gray-400 text-sm">→</span>
          <input
            type="date"
            value={customRange.end}
            onChange={(e) =>
              onCustomRangeChange({ ...customRange, end: e.target.value })
            }
            className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      )}
    </div>
  );
}
