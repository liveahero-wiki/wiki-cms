import { Hono } from 'hono'
import { defaultPurger } from './cache.ts'
import { getAuth } from './auth.ts'
import { apiError, type AppEnv, type Deps } from './http.ts'
import { adminRoutes } from './routes/admin.ts'
import { contribRoutes } from './routes/contrib.ts'
import { internalRoutes } from './routes/internal.ts'
import { publicRoutes } from './routes/public.ts'
import { githubWebhookRoutes } from './routes/webhooks.ts'

export function createApp(overrides: Partial<Deps> = {}) {
  const deps: Deps = { purge: defaultPurger, now: () => Date.now(), ...overrides }
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('deps', deps)
    await next()
    // Everything that is not an explicitly cacheable public read must never be cached.
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'private, no-store')
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
  })

  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api/v1', publicRoutes)
  app.route('/api/contrib', contribRoutes)
  app.route('/api/admin', adminRoutes)
  app.route('/api/internal', internalRoutes)
  app.route('/api/webhooks/github', githubWebhookRoutes)
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    const res = await getAuth(c.env).handler(c.req.raw)
    // Headers on a handler-produced Response may be immutable; copy before the no-store middleware runs.
    return new Response(res.body, res)
  })

  app.notFound((c) => apiError(c, 404, 'not_found', 'Not found.'))
  app.onError((err, c) => {
    console.error('unhandled error', err)
    return apiError(c, 500, 'internal_error', 'Internal server error.')
  })
  return app
}
