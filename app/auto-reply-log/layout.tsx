import { requirePageAccess } from '@/utils/pageAuth';

/** The page itself is a client component; this server layout keeps roles without auto-reply access out. */
export default async function AutoReplyLogLayout({ children }: { children: React.ReactNode }) {
  await requirePageAccess('autoReply');
  return children;
}
