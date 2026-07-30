/**
 * /occupancy — auth-gated live occupancy overview for stakeholders.
 *
 * Deliberately NOT linked anywhere in the reporting-app UI — reachable only by
 * visiting this URL directly. Login is enforced by proxy.ts; every valid role
 * may view (occupancy-only accounts are redirected here from `/`). All data is
 * fetched client-side from /api/occupancy, which is PII-free by construction.
 */
import type { Metadata } from 'next';
import OccupancyStakeholderView from '@/components/occupancy/OccupancyStakeholderView';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Occupancy — Baker House Apartments',
  robots: { index: false, follow: false },
};

export default function OccupancyPage() {
  return <OccupancyStakeholderView />;
}
