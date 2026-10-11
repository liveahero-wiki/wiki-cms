import { createApp } from './core/app.ts'
import { defaultPurger } from './core/cache.ts'
import { runHousekeeping } from './core/housekeeping.ts'
import type { Env } from './env.ts'

const app = createApp()

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runHousekeeping(env, defaultPurger).then((r) => console.log('housekeeping', JSON.stringify(r))),
    )
  },
} satisfies ExportedHandler<Env>
