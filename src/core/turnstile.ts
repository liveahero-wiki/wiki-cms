const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Cloudflare's published always-pass/always-fail test secrets return placeholder hostname/action. */
const isTestSecret = (secret: string) => /^[123]x0+[A-Z]*$/.test(secret) || /^[123]x0{20,}[A-Za-z]*$/.test(secret)

export async function verifyTurnstile(opts: {
  secret: string
  token: unknown
  ip: string | null
  allowedHostnames: string[]
  action: string
}): Promise<boolean> {
  if (typeof opts.token !== 'string' || !opts.token || opts.token.length > 4096) return false
  const body = new URLSearchParams({ secret: opts.secret, response: opts.token })
  if (opts.ip) body.set('remoteip', opts.ip)
  let data: { success?: boolean; hostname?: string; action?: string }
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) })
    data = (await res.json()) as typeof data
  } catch {
    return false
  }
  if (!data.success) return false
  if (isTestSecret(opts.secret)) return true
  return !!data.hostname && opts.allowedHostnames.includes(data.hostname) && data.action === opts.action
}
