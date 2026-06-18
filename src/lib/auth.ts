import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { prisma } from "./db";
import { encrypt } from "./encrypt";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
].join(" ");

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      authorization: {
        params: {
          scope: GOOGLE_SCOPES,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      // Only runs on initial sign-in when `account` is populated.
      if (account && profile) {
        const email = (profile as { email?: string }).email ?? "";
        const googleSub = account.providerAccountId;
        const name = (profile as { name?: string }).name ?? undefined;
        const picture = (profile as { picture?: string }).picture ?? undefined;

        const user = await prisma.user.upsert({
          where: { primaryEmail: email },
          update: { name, picture },
          create: { primaryEmail: email, name, picture },
        });

        const expiresAt = account.expires_at
          ? new Date(account.expires_at * 1000)
          : new Date(Date.now() + 3_600_000);

        await prisma.googleAccount.upsert({
          where: { userId_googleSub: { userId: user.id, googleSub } },
          update: {
            accessToken: encrypt(account.access_token ?? ""),
            ...(account.refresh_token && {
              refreshToken: encrypt(account.refresh_token),
            }),
            expiresAt,
            scopes: account.scope ?? GOOGLE_SCOPES,
          },
          create: {
            userId: user.id,
            googleSub,
            email,
            label: "Personal",
            accessToken: encrypt(account.access_token ?? ""),
            refreshToken: account.refresh_token
              ? encrypt(account.refresh_token)
              : null,
            expiresAt,
            scopes: account.scope ?? GOOGLE_SCOPES,
            isDefault: true,
          },
        });

        token.userId = user.id;
        token.googleSub = googleSub;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.userId === "string") {
        session.user.id = token.userId;
      }
      return session;
    },
  },
});
