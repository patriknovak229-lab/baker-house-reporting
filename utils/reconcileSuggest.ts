import type { BankTransaction } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';

/**
 * Best pending-invoice suggestion for a bank debit — amount within ~1% / 2 Kč,
 * then ranked by name match (exact > mutual-substring > one-directional > word
 * overlap) and date closeness (within 90 days). Returns the top candidate when
 * there's a name signal or it's the only one, else null.
 *
 * Shared by the reconcile drawer (pre-select) and the transaction list (hint icon).
 */
export function findSuggestion(tx: BankTransaction, invoices: SupplierInvoice[]): SupplierInvoice | null {
  const pending = invoices.filter((inv) => inv.status === 'pending' && !inv.bankTransactionId);
  const norm = (s: string) => s.toLowerCase().trim();

  const isForeign = tx.originalCurrency && tx.originalAmount != null;
  const txAmount = isForeign ? (tx.originalAmount ?? tx.amount) : tx.amount;

  const scored: Array<{ inv: SupplierInvoice; score: number }> = [];

  for (const inv of pending) {
    const invAmount = inv.amountCZK;
    const tolerance = Math.max(2, invAmount * 0.01);
    if (Math.abs(txAmount - invAmount) > tolerance) continue;

    const txName = tx.counterpartyName ? norm(tx.counterpartyName) : '';
    const invName = norm(inv.supplierName);
    let nameScore = 0;
    if (txName && invName) {
      if (txName === invName) nameScore = 4;
      else if (txName.includes(invName) && invName.includes(txName)) nameScore = 3;
      else if (txName.includes(invName) || invName.includes(txName)) nameScore = 2;
      else {
        const txWords = txName.split(/\s+/);
        const invWords = invName.split(/\s+/);
        const overlap = txWords.filter((w) => invWords.some((iw) => iw.includes(w) || w.includes(iw))).length;
        if (overlap > 0) nameScore = 1;
      }
    }

    const daysDiff = Math.abs(
      (new Date(tx.date).getTime() - new Date(inv.invoiceDate).getTime()) / 86_400_000,
    );
    const dateScore = daysDiff <= 90 ? (90 - daysDiff) / 90 : 0;

    scored.push({ inv, score: nameScore * 100 + dateScore });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 || scored.length === 1 ? scored[0].inv : null;
}
