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
      // Capture Google access + refresh tokens on first sign-in. They stay in
      // the encrypted JWT only — server routes read them with
      // utils/googleSessionToken.
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
      // Never copy the Google tokens onto the session: this object is also
      // served to the browser by /api/auth/session.
      return session;
    },
  },
});
