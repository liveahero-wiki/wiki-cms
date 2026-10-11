import { drizzle } from 'drizzle-orm/d1'
import { schema } from './schema.ts'
import type { Env } from '../../env.ts'

export type Db = ReturnType<typeof getDb>

export function getDb(env: Pick<Env, 'DB'>) {
  return drizzle(env.DB, { schema })
}
