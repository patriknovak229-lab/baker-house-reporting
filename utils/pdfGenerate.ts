import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

/**
 * Renders an HTML string to a PDF buffer using headless Chromium.
 * Works both locally (via CHROME_EXECUTABLE_PATH) and on Vercel.
 */
export async function generatePDF(html: string): Promise<Buffer> {
  const executablePath =
    process.env.CHROME_EXECUTABLE_PATH ?? await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', right: '18mm', bottom: '14mm', left: '18mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
