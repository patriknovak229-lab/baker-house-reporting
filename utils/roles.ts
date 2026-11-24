/**
 * Who may see or change what — the ONE place that decides it.
 *
 * Three tiers (agreed with Patrik 2026-11-24): Admin, Super User, User. Plus the
 * `occupancy` stakeholder access, which is not a tier: it sees only the PII-free
 * /occupancy grid and nothing else.
 *
 * API routes check this map with `requireAccess(area, 'view' | 'change')`
 * (utils/authGuard) and the UI with `can()`. Who HAS which role lives in the
 * `app_users` table, edited on /admin/users (utils/userRoles.ts resolves it).
 *
 * Client-safe: no server imports here — Nav and AppShell read this module.
 */

export type Role = 'admin' | 'super' | 'user' | 'occupancy';

export const ROLES: Role[] = ['admin', 'super', 'user', 'occupancy'];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  super: 'Super User',
  user: 'User',
  occupancy: 'Stakeholder (occupancy only)',
};

export type Area =
  | 'transactions' // reservations, drawer, guest chat, payment links, guest invoices
  | 'refunds' // Stripe refunds and guest cancellation
  | 'payLater' // pay-later charges (web bookings paid later)
  | 'corporate'
  | 'performance'
  | 'pricing'
  | 'analytics'
  | 'accounting' // every Accounting sub-tab
  | 'autoReply' // auto-reply log, AI drafts and their approval
  | 'occupancy' // the /occupancy grid
  | 'users' // /admin/users
  | 'system'; // manual runs of jobs, backfills, storage map

export type Access = 'view' | 'change';

export const AREA_LABELS: Record<Area, string> = {
  transactions: 'Transactions',
  refunds: 'Stripe refunds',
  payLater: 'Pay-later charges',
  corporate: 'Corporate',
  performance: 'Performance',
  pricing: 'Pricing',
  analytics: 'Analytics',
  accounting: 'Accounting (all sub-tabs)',
  autoReply: 'Auto-reply',
  occupancy: 'Occupancy grid',
  users: 'Users page',
  system: 'System jobs',
};

const ADMIN: Role[] = ['admin'];
const ADMIN_SUPER: Role[] = ['admin', 'super'];

export const PERMISSIONS: Record<Area, Record<Access, Role[]>> = {
  transactions: { view: ['admin', 'super', 'user'], change: ADMIN_SUPER },
  refunds: { view: ['admin', 'super', 'user'], change: ADMIN_SUPER },
  // Charging a guest stays admin-only (Patrik, 7 Nov 2026); everyone on
  // Transactions can see where a payment stands.
  payLater: { view: ['admin', 'super', 'user'], change: ADMIN },
  corporate: { view: ADMIN_SUPER, change: ADMIN_SUPER },
  performance: { view: ADMIN_SUPER, change: ADMIN },
  pricing: { view: ADMIN, change: ADMIN },
  analytics: { view: ADMIN_SUPER, change: ADMIN },
  accounting: { view: ADMIN, change: ADMIN },
  autoReply: { view: ADMIN_SUPER, change: ADMIN_SUPER },
  occupancy: { view: ['admin', 'super', 'user', 'occupancy'], change: ['admin', 'super', 'user', 'occupancy'] },
  users: { view: ADMIN, change: ADMIN },
  system: { view: ADMIN, change: ADMIN },
};

export function can(role: Role | null | undefined, area: Area, access: Access = 'view'): boolean {
  return !!role && PERMISSIONS[area][access].includes(role);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

// ── Main-app tabs (AppShell / Nav) ──────────────────────────────────────────

export type Tab = 'transactions' | 'corporate' | 'performance' | 'accounting' | 'pricing';

/** Roles that may open /analytics (a standalone route, not an AppShell tab). */
export const ANALYTICS_ROLES: Role[] = PERMISSIONS.analytics.view;

/** Everyone who may open /occupancy, stakeholders included. */
export const OCCUPANCY_VIEW_ROLES: Role[] = PERMISSIONS.occupancy.view;

export function canAccessAnalytics(role: Role): boolean {
  return can(role, 'analytics');
}

export function canAccessTab(role: Role, tab: Tab): boolean {
  return can(role, tab);
}

export function canMutate(role: Role, area: Tab): boolean {
  return can(role, area, 'change');
}

export function getDefaultTab(role: Role): Tab {
  const first = (['transactions', 'performance', 'corporate', 'pricing', 'accounting'] as Tab[]).find((t) =>
    can(role, t),
  );
  return first ?? 'transactions';
}
