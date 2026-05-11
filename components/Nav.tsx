'use client';
import { useSession, signOut } from 'next-auth/react';
import type { Role, Tab } from '@/utils/roles';
import { canAccessTab } from '@/utils/roles';

interface NavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const ALL_TABS: { id: Tab; label: string }[] = [
  { id: 'transactions', label: 'Transactions' },
  { id: 'performance', label: 'Performance' },
  { id: 'accounting', label: 'Accounting' },
  { id: 'pricing', label: 'Pricing' },
];

export default function Nav({ activeTab, onTabChange }: NavProps) {
  const { data: session } = useSession();
  const role = session?.user?.role as Role | undefined;
  const tabs = ALL_TABS.filter((t) => !role || canAccessTab(role, t.id));

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-40 print:hidden">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-6 flex items-center h-14 gap-3 sm:gap-8">
        {/* Logo — compact on mobile (the subtitle/text wraps badly in tight space) */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className="w-8 h-8 rounded-md bg-indigo-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">BH</span>
          </div>
          <span className="font-semibold text-gray-900 text-sm leading-tight hidden sm:block">
            Baker House<br />
            <span className="text-gray-400 font-normal text-xs">Apartments</span>
          </span>
        </div>

        {/* Tabs — scrolls horizontally inside the nav strip on narrow viewports
            instead of stretching the whole page wider than the screen. */}
        <nav className="flex gap-1 flex-1 min-w-0 overflow-x-auto -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`px-3 sm:px-4 py-2 text-sm rounded-md font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeTab === tab.id
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* User + sign out — sign-out becomes an icon-only chip on mobile so
            the strip stays narrow. Name still hides under sm: as before. */}
        {session?.user && (
          <div className="flex items-center gap-2 sm:gap-3 ml-auto shrink-0">
            <span className="text-sm text-gray-500 hidden sm:block">
              {session.user.name}
            </span>
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
              title="Sign out"
            >
              <svg className="w-4 h-4 sm:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export type { Tab };
