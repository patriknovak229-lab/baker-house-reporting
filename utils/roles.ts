export type Role = 'admin' | 'super' | 'viewer' | 'accountant';
export type Tab = 'transactions' | 'performance' | 'accounting' | 'pricing';

const TAB_ACCESS: Record<Tab, Role[]> = {
  transactions: ['admin', 'super'],
  performance: ['admin', 'super', 'viewer'],
  accounting: ['admin', 'accountant'],
  pricing: ['admin', 'super'],
};

export function getRoleForEmail(email: string): Role | null {
  const check = (envVar: string) =>
    (process.env[envVar] ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .includes(email);
  if (check('ADMIN_EMAILS')) return 'admin';
  if (check('SUPER_EMAILS')) return 'super';
  if (check('VIEWER_EMAILS')) return 'viewer';
  if (check('ACCOUNTANT_EMAILS')) return 'accountant';
  return null;
}

export function canAccessTab(role: Role, tab: Tab): boolean {
  return TAB_ACCESS[tab].includes(role);
}

export function getDefaultTab(role: Role): Tab {
  if (role === 'admin' || role === 'super') return 'transactions';
  if (role === 'viewer') return 'performance';
  return 'accounting';
}

/** Transactions mutations: admin + super. Performance/accounting mutations: admin only. */
export function canMutate(role: Role, area: Tab): boolean {
  if (area === 'transactions') return role === 'admin' || role === 'super';
  return role === 'admin';
}
