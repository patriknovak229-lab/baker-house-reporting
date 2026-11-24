/**
 * /admin/users — who may sign in and with which role. Admin only, and
 * deliberately NOT linked from the main app (open it by URL, like
 * /auto-reply-log).
 */
import type { Metadata } from 'next';
import UsersAdmin from '@/components/admin/UsersAdmin';
import { requirePageAccess } from '@/utils/pageAuth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Users — Baker House',
  robots: { index: false, follow: false },
};

export default async function UsersPage() {
  await requirePageAccess('users');
  return <UsersAdmin />;
}
