import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { getRoleForEmail } from '@/utils/roles';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    // Operator sign-in (main app). Needs Gmail-read + Drive for the reconciliation
    // / Drive-upload features, so it requests those sensitive scopes + an offline
    // refresh token. This is the provider that drives the "unverified app" screen.
    Google({
      authorization: {
        params: {
          scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive',
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    }),
    // Stakeholder "viewer" sign-in (occupancy page only). Bare-minimum identity
    // scopes — no Gmail/Drive — so there's no sensitive-scope consent, no
    // "unverified app" warning, and it doesn't count against the OAuth user cap.
    // Same underlying OAuth client; callback path is /api/auth/callback/google-viewer.
    Google({
      id: 'google-viewer',
      name: 'Google',
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: { params: { scope: 'openid email profile' } },
    }),
  ],
  pages: { signIn: '/login' },
  callbacks: {
    async signIn({ user }) {
      // Reject anyone not in an allowed email list
      return getRoleForEmail(user.email ?? '') !== null;
    },
    async jwt({ token, user, account }) {
      if (user?.email) {
        const role = getRoleForEmail(user.email);
        if (role) token.role = role;
      }
      // Capture Google access + refresh tokens on first sign-in
      if (account?.provider === 'google') {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.role) {
        (session.user as unknown as Record<string, unknown>).role = token.role;
      }
      // Expose tokens for server-side API calls (Drive upload, etc.)
      (session as unknown as Record<string, unknown>).accessToken = token.accessToken;
      (session as unknown as Record<string, unknown>).refreshToken = token.refreshToken;
      return session;
    },
  },
});
