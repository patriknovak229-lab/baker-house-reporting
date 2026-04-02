import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { getRoleForEmail } from '@/utils/roles';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  pages: { signIn: '/login' },
  callbacks: {
    async signIn({ user }) {
      // Reject anyone not in an allowed email list
      return getRoleForEmail(user.email ?? '') !== null;
    },
    async jwt({ token, user }) {
      if (user?.email) {
        const role = getRoleForEmail(user.email);
        if (role) token.role = role;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.role) {
        (session.user as unknown as Record<string, unknown>).role = token.role;
      }
      return session;
    },
  },
});
