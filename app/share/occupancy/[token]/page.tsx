/**
 * /share/occupancy/[token] — PUBLIC occupancy snapshot page (no login).
 *
 * Reads the frozen, PII-free snapshot straight from the store (server
 * component) and renders it. Returns a friendly card when the token is
 * unknown / revoked / expired. Exempted from auth in proxy.ts (matcher
 * excludes `share`).
 */

import type { Metadata } from 'next';
import { getSnapshot } from '@/utils/occupancySnapshotStore';
import { toPublicSnapshot } from '@/types/occupancySnapshot';
import OccupancySnapshotView from '@/components/public/OccupancySnapshotView';

// Snapshot content can change (regenerate) and must never be statically
// cached across tokens — always render per request.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Occupancy Report — Baker House Apartments',
  robots: { index: false, follow: false },
};

function NotFoundCard() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 max-w-md w-full px-8 py-10 text-center">
        <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Link unavailable</h1>
        <p className="text-sm text-gray-500">
          This occupancy report link is no longer valid — it may have expired or been revoked.
          Please ask for a fresh link.
        </p>
        <p className="mt-6 text-sm text-gray-400">
          Baker House Apartments ·{' '}
          <a href="https://www.bakerhouseapartments.cz" className="underline hover:text-gray-600">
            bakerhouseapartments.cz
          </a>
        </p>
      </div>
    </div>
  );
}

export default async function OccupancySharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const snapshot = await getSnapshot(token);

  if (!snapshot) {
    return <NotFoundCard />;
  }

  return <OccupancySnapshotView snapshot={toPublicSnapshot(snapshot)} />;
}
