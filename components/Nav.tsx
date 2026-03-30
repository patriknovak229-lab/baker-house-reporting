'use client';
type Tab = "transactions" | "performance" | "accounting";

interface NavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

export default function Nav({ activeTab, onTabChange }: NavProps) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "transactions", label: "Transactions" },
    { id: "performance", label: "Performance" },
    { id: "accounting", label: "Accounting" },
  ];

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-40 print:hidden">
      <div className="max-w-screen-2xl mx-auto px-6 flex items-center h-14 gap-8">
        {/* Logo + name */}
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
        <nav className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`px-4 py-2 text-sm rounded-md font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}

export type { Tab };
