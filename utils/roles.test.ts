import { describe, expect, it } from 'vitest';
import { can, getDefaultTab, type Area, type Role } from './roles';

/** The matrix Patrik set on 2026-11-24. Change it here and in utils/roles.ts together. */
const EXPECTED: Record<Exclude<Role, 'admin'>, Partial<Record<Area, 'view' | 'change' | 'none'>>> = {
  super: {
    transactions: 'change',
    refunds: 'change',
    corporate: 'change',
    performance: 'view',
    pricing: 'none',
    analytics: 'view',
    accounting: 'none',
    autoReply: 'change',
    occupancy: 'change',
    users: 'none',
  },
  user: {
    transactions: 'view',
    refunds: 'view',
    corporate: 'none',
    performance: 'none',
    pricing: 'none',
    analytics: 'none',
    accounting: 'none',
    autoReply: 'none',
    occupancy: 'change',
    users: 'none',
  },
  occupancy: {
    transactions: 'none',
    refunds: 'none',
    corporate: 'none',
    performance: 'none',
    pricing: 'none',
    analytics: 'none',
    accounting: 'none',
    autoReply: 'none',
    occupancy: 'change',
    users: 'none',
  },
};

function level(role: Role, area: Area): 'view' | 'change' | 'none' {
  if (can(role, area, 'change')) return 'change';
  return can(role, area, 'view') ? 'view' : 'none';
}

describe('permission matrix', () => {
  it('gives admin everything', () => {
    for (const area of ['transactions', 'refunds', 'payLater', 'corporate', 'performance', 'pricing', 'analytics', 'accounting', 'autoReply', 'occupancy', 'users', 'system'] as Area[]) {
      expect(level('admin', area)).toBe('change');
    }
  });

  for (const [role, areas] of Object.entries(EXPECTED) as [Role, Record<Area, string>][]) {
    it(`matches the agreed rights for ${role}`, () => {
      for (const [area, want] of Object.entries(areas) as [Area, string][]) {
        expect(`${area}: ${level(role, area)}`).toBe(`${area}: ${want}`);
      }
    });
  }

  it('keeps pay-later charges admin-only but visible on Transactions', () => {
    expect(level('super', 'payLater')).toBe('view');
    expect(level('user', 'payLater')).toBe('view');
  });

  it('opens Transactions first for every tier', () => {
    expect(getDefaultTab('admin')).toBe('transactions');
    expect(getDefaultTab('super')).toBe('transactions');
    expect(getDefaultTab('user')).toBe('transactions');
  });

  it('denies a missing role', () => {
    expect(can(undefined, 'occupancy')).toBe(false);
  });
});
