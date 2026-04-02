const BEDS24_API_BASE = "https://beds24.com/api/v2";

// Module-level cache — survives across requests within the same server process.
// Next.js serverless functions are short-lived, so this mainly helps within a
// single cold-start window, but it prevents redundant token fetches on warm instances.
let cachedToken: string | null = null;
let tokenExpiresAt = 0; // Unix ms

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  // Refresh 60 seconds before expiry to avoid using a token that expires mid-request
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const refreshToken = process.env.BEDS24_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("BEDS24_REFRESH_TOKEN not set");
  }

  const res = await fetch(`${BEDS24_API_BASE}/authentication/token`, {
    headers: { refreshToken },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beds24 token refresh failed ${res.status}: ${text}`);
  }

  const json = await res.json();
  cachedToken = json.token as string;
  // expiresIn is in seconds
  tokenExpiresAt = now + (json.expiresIn as number) * 1000;

  return cachedToken;
}
