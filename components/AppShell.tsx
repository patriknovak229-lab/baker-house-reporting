'use client';

import { useState } from "react";
import Nav from "@/components/Nav";
import type { Tab } from "@/components/Nav";
import TransactionsPage from "@/components/transactions/TransactionsPage";
import PerformancePage from "@/components/performance/PerformancePage";

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
  const [activeTab, setActiveTab] = useState<Tab>("transactions");

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav activeTab={activeTab} onTabChange={setActiveTab} />
      <main>
        {activeTab === "transactions" && <TransactionsPage />}
        {activeTab === "performance" && <PerformancePage />}
        {activeTab === "accounting" && <ComingSoon tab="Accounting" />}
      </main>
    </div>
  );
}
