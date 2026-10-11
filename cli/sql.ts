/** SQL literal helpers. wrangler has no bind parameters, so every value goes through here. */

export type SqlValue = string | number | boolean | null | undefined | unknown[] | Record<string, unknown>

export function sqlLiteral(v: SqlValue): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Refusing non-finite number in SQL: ${v}`)
    return String(v)
  }
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s.includes('\0')) throw new Error('Refusing NUL byte in SQL string')
  return `'${s.replace(/'/g, "''")}'`
}

/** Tagged template: sql`... ${value} ...` with every interpolation escaped as a literal. */
export function sql(strings: TemplateStringsArray, ...values: SqlValue[]): string {
  let out = strings[0]!
  values.forEach((v, i) => {
    out += sqlLiteral(v) + strings[i + 1]!
  })
  return out
}
