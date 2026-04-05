import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { getRoleForEmail } from '@/utils/roles';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: {
          scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file',
          access_type: 'offline',
          prompt: 'consent',
        },
      },
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
      // Expose access token for server-side Gmail API calls
      (session as unknown as Record<string, unknown>).accessToken = token.accessToken;
      return session;
    },
  },
});
