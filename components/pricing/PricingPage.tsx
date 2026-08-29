'use client';
/**
 * Pricing tab — two complementary views:
 *
 *  Radar  — demand calendar + our price vs the market, from the PriceLabs
 *           snapshot in Postgres. No scraping anywhere near it.
 *  Parity — what a customer actually sees on Web / Airbnb / Booking.com,
 *           observed by the local Mac runner (scripts/parity-runner) and
 *           ingested into Postgres. The old serverless scraper is gone: Vercel
 *           datacenter IPs are bot-walled by Booking.com and always will be.
 */
import { useState } from 'react';
import RadarView from './RadarView';
import ParityView from './ParityView';

export default function PricingPage() {
  const [view, setView] = useState<'radar' | 'parity'>('radar');

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Pricing</h1>
          <p className="text-sm text-gray-500 mt-1">
            Demand radar from PriceLabs market data, and channel parity checks from the local price runner.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-sm font-medium">
          {[
            { id: 'radar' as const, label: 'Radar' },
            { id: 'parity' as const, label: 'Parity check' },
          ].map((opt) => (
            <button
              key={opt.id}
              onClick={() => setView(opt.id)}
              className={`px-4 py-1.5 rounded-md transition-colors ${
                view === opt.id ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'radar' ? <RadarView /> : <ParityView />}
    </div>
  );
}
