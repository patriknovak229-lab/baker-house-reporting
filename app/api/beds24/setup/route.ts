import { NextResponse } from "next/server";

// ONE-TIME setup endpoint.
// Hit this once after adding your invite token as BEDS24_API_KEY.
// It exchanges the invite token for a permanent refresh token.
// Copy the refreshToken from the response and add it to Vercel as BEDS24_REFRESH_TOKEN.
// You can then delete BEDS24_API_KEY from Vercel (the invite token is no longer needed).

export async function GET() {
  const inviteToken = process.env.BEDS24_API_KEY;
  if (!inviteToken) {
    return NextResponse.json({ error: "BEDS24_API_KEY (invite token) not set" }, { status: 500 });
  }

  const res = await fetch("https://beds24.com/api/v2/authentication/setup", {
    headers: { token: inviteToken },
    cache: "no-store",
  });

  const json = await res.json();

  if (!res.ok) {
    return NextResponse.json({ error: "Beds24 setup failed", details: json }, { status: res.status });
  }

  // Return just what you need — copy refreshToken into Vercel as BEDS24_REFRESH_TOKEN
  return NextResponse.json({
    success: true,
    refreshToken: json.refreshToken,
    accessToken: json.token,
    expiresIn: json.expiresIn,
    instruction: "Add refreshToken to Vercel as BEDS24_REFRESH_TOKEN, then redeploy.",
  });
}
