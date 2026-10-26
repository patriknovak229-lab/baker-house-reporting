/**
 * GA4 Data API — traffic sources for the Web funnel tab. SERVER ONLY.
 *
 * READ-ONLY by construction: the only scope requested is `analytics.readonly`, and the
 * only call is properties.runReport. Nothing here can change the GA property.
 *
 * Auth is a Google Cloud service account whose JSON key lives ONLY in the Vercel env
 * var GA4_SERVICE_ACCOUNT_JSON (raw JSON or base64 of it) — this repo is public, so
 * the key must never be committed. The service account is added as a Viewer on the
 * GA property; see docs/analytics.md §10 for the click-by-click setup.
 *
 * What it can and cannot say: GA only measures visitors who accepted cookies and
 * don't block Google, so these are SAMPLE numbers — good for the channel mix, not
 * for volumes. Funnel volumes come from the site's own counts.
 */
import { google } from 'googleapis';
import { parseGaReport, type GaTrafficRow } from '@/utils/webFunnel';

/** bakerhouseapartments.cz — GA4 property "BHA WEB" stream's parent. Not a secret. */
export const GA4_DEFAULT_PROPERTY_ID = '529936917';

const PAGE_SIZE = 10_000;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/** The service-account key from the env, or null when it is not set / not usable. */
export function ga4Credentials(raw = process.env.GA4_SERVICE_ACCOUNT_JSON): ServiceAccountKey | null {
  const value = raw?.trim();
  if (!value) return null;
  const candidates = [value];
  if (!value.startsWith('{')) {
    try {
      candidates.push(Buffer.from(value, 'base64').toString('utf8'));
    } catch {
      /* not base64 either */
    }
  }
  for (const text of candidates) {
    try {
      const key = JSON.parse(text) as Partial<ServiceAccountKey>;
      if (typeof key.client_email === 'string' && typeof key.private_key === 'string') {
        return { client_email: key.client_email, private_key: key.private_key, project_id: key.project_id };
      }
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

export function ga4PropertyId(): string {
  const id = process.env.GA4_PROPERTY_ID?.trim();
  return id && /^\d+$/.test(id) ? id : GA4_DEFAULT_PROPERTY_ID;
}

/**
 * Sessions, users and purchases per day × default channel group × source/medium.
 * Paginates; a quiet property returns a few hundred rows a month.
 */
export async function fetchGaTraffic(from: string, to: string): Promise<GaTrafficRow[]> {
  const credentials = ga4Credentials();
  if (!credentials) throw new Error('GA4_SERVICE_ACCOUNT_JSON is not set or not a service-account key');

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });

  const rows: GaTrafficRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await analyticsdata.properties.runReport({
      property: `properties/${ga4PropertyId()}`,
      requestBody: {
        dateRanges: [{ startDate: from, endDate: to }],
        dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }, { name: 'sessionSourceMedium' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'ecommercePurchases' },
          { name: 'purchaseRevenue' },
        ],
        limit: String(PAGE_SIZE),
        offset: String(offset),
      },
    });
    rows.push(...parseGaReport(res.data));
    const total = Number(res.data.rowCount ?? 0);
    if (!res.data.rows?.length || offset + PAGE_SIZE >= total) break;
  }
  return rows;
}
