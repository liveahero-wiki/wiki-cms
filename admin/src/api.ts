import type { ApiErrorBody, FieldError } from '../../src/shared/api-types.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly fields: FieldError[]
  constructor(status: number, code: string, message: string, fields: FieldError[] = []) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
}

/** Set by the app shell; called when any admin call comes back 401 (session expired / signed out elsewhere). */
export const authHooks = { onUnauthorized: () => {} }

async function request<T>(url: string, method: string, body?: unknown, opts: { quiet401?: boolean } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'network', 'Network error. Check your connection and try again.')
  }
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      /* non-JSON body */
    }
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error
    if (res.status === 401 && !opts.quiet401) authHooks.onUnauthorized()
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status}).`, err?.fields)
  }
  return data as T
}

/** Admin API call (`/api/admin` + path). */
export const api = {
  get: <T>(path: string, opts?: { quiet401?: boolean }) => request<T>(`/api/admin${path}`, 'GET', undefined, opts),
  post: <T>(path: string, body: unknown) => request<T>(`/api/admin${path}`, 'POST', body),
  patch: <T>(path: string, body: unknown) => request<T>(`/api/admin${path}`, 'PATCH', body),
  del: <T>(path: string) => request<T>(`/api/admin${path}`, 'DELETE'),
}

/** Any absolute-path call (public API, BetterAuth). */
export const raw = {
  get: <T>(url: string) => request<T>(url, 'GET'),
  post: <T>(url: string, body: unknown) => request<T>(url, 'POST', body, { quiet401: true }),
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
