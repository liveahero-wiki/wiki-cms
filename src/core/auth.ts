import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { eq } from 'drizzle-orm'
import type { Env } from '../env.ts'
import { writeAudit } from './audit.ts'
import { getDb } from './db/client.ts'
import { moderator_permission_tab, schema } from './db/schema.ts'

function createAuth(env: Env) {
  const db = getDb(env)
  return betterAuth({
    baseURL: env.PUBLIC_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.PUBLIC_URL],
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user_tab: schema.user_tab,
        session_tab: schema.session_tab,
        account_tab: schema.account_tab,
        verification_tab: schema.verification_tab,
      },
    }),
    user: { modelName: 'user_tab' },
    session: { modelName: 'session_tab' },
    account: { modelName: 'account_tab' },
    verification: { modelName: 'verification_tab' },
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              // `openid profile` only: never request the email scope.
              scope: ['openid', 'profile'],
              disableDefaultScope: true,
              mapProfileToUser: (p: { sub: string; name?: string; picture?: string }) => ({
                email: `google-${p.sub}@users.invalid`,
                emailVerified: false,
                name: p.name,
                image: p.picture,
              }),
            },
          }
        : {}),
      discord: {
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
        // `identify` only: never request the email scope.
        scope: ['identify'],
        disableDefaultScope: true,
        mapProfileToUser: (p) => ({
          // BetterAuth requires an email; use a synthetic one that is never displayed.
          email: `discord-${p.id}@users.invalid`,
          emailVerified: false,
          name: p.global_name ?? p.username,
          image: p.image_url,
        }),
      },
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            const perm = await db
              .select({ t: moderator_permission_tab.type })
              .from(moderator_permission_tab)
              .where(eq(moderator_permission_tab.userId, session.userId))
              .get()
            if (perm) await writeAudit(db, { actor: session.userId, action: 'auth.sign_in' })
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>

const memo = new WeakMap<object, Auth>()

/** One BetterAuth instance per env object (isolate lifetime). */
export function getAuth(env: Env): Auth {
  let a = memo.get(env)
  if (!a) {
    a = createAuth(env)
    memo.set(env, a)
  }
  return a
}
