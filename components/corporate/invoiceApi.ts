/**
 * Client calls for corporate invoices — shared by the agreement's Invoices
 * panel and the "check invoice payment" panel on Transactions.
 */
import type { CorporateInvoice } from '@/utils/corporateInvoice';

export type InvoiceAction = 'issue' | 'send' | 'reschedule' | 'cancel' | 'void' | 'markPaid' | 'unmarkPaid' | 'snooze';

export interface ActionResult {
  invoice?: CorporateInvoice;
  deleted?: boolean;
  outcome?: 'sent' | 'deferred';
  notes?: string[];
  revenueError?: string | null;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function invoiceAction(id: string, action: InvoiceAction, extra: Record<string, unknown> = {}): Promise<ActionResult> {
  const res = await fetch('/api/corporate/invoices/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action, ...extra }),
  });
  return json<ActionResult>(res);
}

export async function listInvoices(agreementId: string): Promise<CorporateInvoice[]> {
  const res = await fetch(`/api/corporate/invoices?agreementId=${encodeURIComponent(agreementId)}`);
  return (await json<{ invoices: CorporateInvoice[] }>(res)).invoices;
}

/** The invoice as HTML in a new tab — the frozen document, or a watermarked preview while scheduled. */
export function openInvoiceHtml(id: string): void {
  window.open(`/api/corporate/invoices/document?id=${encodeURIComponent(id)}&format=html`, '_blank', 'noopener');
}

export async function downloadInvoicePdf(id: string): Promise<void> {
  const res = await fetch(`/api/corporate/invoices/document?id=${encodeURIComponent(id)}&format=pdf`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const match = (res.headers.get('Content-Disposition') ?? '').match(/filename="([^"]+)"/);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] ?? 'invoice.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "25 Nov 2026" */
export function invoiceDate(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  return new Date(`${ymd.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function czkExact(n: number): string {
  return `${n.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} Kč`;
}
