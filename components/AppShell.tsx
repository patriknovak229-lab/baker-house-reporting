'use client';
import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import Nav from '@/components/Nav';
import type { Role, Tab } from '@/utils/roles';
import { canAccessTab, getDefaultTab } from '@/utils/roles';
import TransactionsPage from '@/components/transactions/TransactionsPage';
import PerformancePage from '@/components/performance/PerformancePage';

function ComingSoon({ tab }: { tab: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-96 text-gray-400">
      <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      </div>
      <p className="text-lg font-medium text-gray-500">{tab}</p>
      <p className="text-sm mt-1">Coming soon</p>
    </div>
  );
}

export default function AppShell() {
  const { data: session, status } = useSession();
  const role = session?.user?.role as Role | undefined;
  const [activeTab, setActiveTab] = useState<Tab>('transactions');

  // Once role is known, jump to the user's default tab
  useEffect(() => {
    if (role) setActiveTab(getDefaultTab(role));
  }, [role]);

  function handleTabChange(tab: Tab) {
    if (!role || canAccessTab(role, tab)) setActiveTab(tab);
  }

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav activeTab={activeTab} onTabChange={handleTabChange} />
      <main>
        {activeTab === 'transactions' && <TransactionsPage />}
        {activeTab === 'performance' && <PerformancePage />}
        {activeTab === 'accounting' && <ComingSoon tab="Accounting" />}
      </main>
    </div>
  );
}
