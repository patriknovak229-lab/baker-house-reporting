/**
 * Run the supplier-invoice extraction on a local folder of PDFs / photos and
 * print what would be saved, plus the sanity-check issues for each file.
 * Writes <folder>/_results.json. Use it to reproduce a parsing problem and to
 * prove a fix before pushing. Keep invoice files OUT of this (public) repo.
 *
 *   npx tsx scripts/eval-invoices.ts <folder> [filename-substring]
 *
 * Needs ANTHROPIC_API_KEY in .env.local (prefix with `env -u ANTHROPIC_API_KEY`
 * if your shell exports a different key — dotenv never overrides the shell).
 */
import './_loadEnv';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
process.env.STORE_INVOICE_CATEGORIES = 'postgres';
(async () => {
  const { readAllInvoiceCategories } = await import('@/utils/invoiceCategoriesStore');
  const { extractInvoice } = await import('@/utils/invoiceExtraction');
  const { checkInvoice } = await import('@/utils/invoiceChecks');
  const dir = process.argv[2];
  const only = process.argv[3];
  const categories = await readAllInvoiceCategories();
  const files = readdirSync(dir).filter((f) => /\.(pdf|jpe?g|png)$/i.test(f) && !f.startsWith('_') && (!only || f.includes(only)));
  const results: Record<string, unknown> = {};
  const queue = [...files];
  async function worker() {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const ext = path.extname(f).toLowerCase();
      const mediaType = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
      const t0 = Date.now();
      try {
        const r = await extractInvoice({ data: readFileSync(path.join(dir, f)), mediaType, fileName: f, categories });
        const issues = checkInvoice({ supplierName: r.supplierName, supplierICO: r.supplierICO, invoiceDate: r.invoiceDate, amount: r.amountCZK, vat: r.vatAmountCZK, currency: r.invoiceCurrency, documentType: r.documentType, vatBreakdown: r.vatBreakdown, hasOriginalInvoice: !!r.originalInvoiceNumber });
        results[f] = { secs: (Date.now() - t0) / 1000, ...r, issues };
        console.log(`${f} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${r.documentType} | ${r.supplierName} | ${r.supplierICO} | #${r.invoiceNumber} | ${r.invoiceDate} duzp=${r.duzpDate} | ${r.amountCZK} ${r.invoiceCurrency} vat=${r.vatAmountCZK} | ${r.suggestedCategory}${r.knownSupplierId ? ' [known]' : ''} | VAT ${JSON.stringify(r.vatBreakdown)} | issues: ${issues.map((i) => i.message).join('; ') || 'none'}`);
      } catch (e) {
        console.log(`${f}: ERROR ${(e as Error).message}`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  writeFileSync(path.join(dir, '_results.json'), JSON.stringify(results, null, 1));
  process.exit(0);
})();
