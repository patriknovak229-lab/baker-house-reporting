import type { BankTransaction, RecurringCostCategoryId } from './bankTransaction';

/**
 * A rule that auto-classifies an incoming bank debit as a `recurring_cost`
 * (rent, parking, …) on import — for contractual standing orders that never
 * have a supplier invoice to match against.
 *
 * A rule matches on the AND of every identity field it specifies. At least one
 * identity field (account / VS / name) must be present, so a rule can never
 * match every debit. `amount`, when set, adds a fixed-amount guard (±1 Kč).
 */
export interface BankCostRule {
  id: string;
  /** Human label shown in the UI, e.g. "Rent K201–203" */
  label: string;
  costCategory: RecurringCostCategoryId;
  /** Counterparty account number (exact) */
  counterpartyAccount?: string;
  /** Variable symbol (exact) */
  variableSymbol?: string;
  /** Normalised substring match against counterparty name / description */
  counterpartyNameContains?: string;
  /** Fixed-amount guard — when set, tx.amount must be within ±1 Kč */
  amount?: number;
  createdAt: string;
}

/** Redis key for the recurring-cost whitelist */
export const BANK_COST_WHITELIST_KEY = 'baker:bank-cost-whitelist';

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** True if the rule specifies at least one usable identity field. */
export function ruleHasIdentity(rule: Partial<BankCostRule>): boolean {
  return !!(
    rule.counterpartyAccount?.trim() ||
    rule.variableSymbol?.trim() ||
    rule.counterpartyNameContains?.trim()
  );
}

/** True if `tx` matches every identity/amount condition the rule specifies. */
export function matchesCostRule(tx: BankTransaction, rule: BankCostRule): boolean {
  if (tx.direction !== 'debit') return false;
  if (!ruleHasIdentity(rule)) return false;

  if (rule.counterpartyAccount) {
    if ((tx.counterpartyAccount ?? '').trim() !== rule.counterpartyAccount.trim()) return false;
  }
  if (rule.variableSymbol) {
    if ((tx.variableSymbol ?? '').trim() !== rule.variableSymbol.trim()) return false;
  }
  if (rule.counterpartyNameContains) {
    const hay = norm([tx.counterpartyName, tx.description, tx.myDescription].filter(Boolean).join(' '));
    if (!hay.includes(norm(rule.counterpartyNameContains))) return false;
  }
  if (rule.amount != null) {
    if (Math.abs(tx.amount - rule.amount) > 1) return false;
  }
  return true;
}

/**
 * Build a rule from a transaction the user just classified. Prefers the account
 * + variable symbol as the identity; falls back to the counterparty name only
 * when neither is present. Returns null when no identity can be derived.
 */
export function buildRuleFromTx(
  tx: BankTransaction,
  opts: { label?: string; costCategory: RecurringCostCategoryId; fixedAmount: boolean },
): BankCostRule | null {
  const account = tx.counterpartyAccount?.trim();
  const vs = tx.variableSymbol?.trim();
  const name = (tx.counterpartyName || tx.description || tx.myDescription || '').trim();

  const rule: BankCostRule = {
    id: `costrule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: opts.label?.trim() || name || 'Recurring cost',
    costCategory: opts.costCategory,
    createdAt: new Date().toISOString(),
  };

  if (account) rule.counterpartyAccount = account;
  if (vs) rule.variableSymbol = vs;
  // Only fall back to name matching when there's no stronger identity.
  if (!account && !vs && name) rule.counterpartyNameContains = name;
  if (opts.fixedAmount) rule.amount = tx.amount;

  return ruleHasIdentity(rule) ? rule : null;
}
