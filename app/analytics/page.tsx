/**
 * /analytics
 *
 * Standalone route rather than an `AppShell` tab — see the note at the top of
 * `components/analytics/AnalyticsPage.tsx` for why. Auth is enforced twice on
 * purpose: `proxy.ts` blocks anonymous requests to the page, this server
 * component checks the ROLE before rendering anything, and every
 * `/api/analytics/*` handler checks it again. A page that renders for the wrong
 * role and then shows empty charts is worse than a redirect.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { canAccessAnalytics, type Role } from '@/utils/roles';
import AnalyticsPage from '@/components/analytics/AnalyticsPage';

export const metadata = {
  title: 'Analytics — Baker House Apartments',
};

export default async function Page() {
  // Local dev bypass, matching app/page.tsx: skip OAuth when DEV_ADMIN_EMAIL is set.
  if (process.env.NODE_ENV === 'development' && process.env.DEV_ADMIN_EMAIL) {
    return <AnalyticsPage canRefreshMarket />;
  }

  const session = await auth();
  const role = (session?.user as { role?: Role } | undefined)?.role;
  if (!role || !canAccessAnalytics(role)) {
    // Occupancy stakeholders have their own page; everyone else lands on the
    // dashboard, which will route them to whatever they can see.
    redirect(role === 'occupancy' ? '/occupancy' : '/');
  }

  /**
   * Refreshing the market snapshot is narrower than reading it: the call costs
   * money (PriceLabs bills per synced listing) and takes tens of seconds, so the
   * button only appears for the roles the refresh route itself accepts. Everyone
   * else sees whatever the daily cron last captured.
   */
  return <AnalyticsPage canRefreshMarket={role === 'admin' || role === 'super'} />;
}
