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
      <div className="max-w-screen-2xl mx-auto px-6 flex items-center h-14 gap-8">
        {/* Logo */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-md bg-indigo-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">BH</span>
          </div>
          <span className="font-semibold text-gray-900 text-sm leading-tight">
            Baker House<br />
            <span className="text-gray-400 font-normal text-xs">Apartments</span>
          </span>
        </div>

        {/* Tabs */}
        <nav className="flex gap-1 flex-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`px-4 py-2 text-sm rounded-md font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* User + sign out */}
        {session?.user && (
          <div className="flex items-center gap-3 ml-auto shrink-0">
            <span className="text-sm text-gray-500 hidden sm:block">
              {session.user.name}
            </span>
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export type { Tab };
