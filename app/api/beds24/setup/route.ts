import { NextResponse } from "next/server";

// ONE-TIME setup endpoint.
// Hit this once after adding a fresh invite token as BEDS24_INVITE_TOKEN.
// It exchanges the invite token for a permanent refresh token.
// Copy the refreshToken from the response and add it to Vercel as BEDS24_REFRESH_TOKEN.

export async function GET() {
  const inviteToken = process.env.BEDS24_INVITE_TOKEN;
  if (!inviteToken) {
    return NextResponse.json({ error: "BEDS24_INVITE_TOKEN not set" }, { status: 500 });
  }

  const res = await fetch("https://beds24.com/api/v2/authentication/setup", {
    headers: { code: inviteToken },
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
