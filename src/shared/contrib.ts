/** Shared by the Worker and the embed (so the sign-in UI can quote the rule). */
export const CONTRIB_MIN_ACCOUNT_AGE_DAYS = 30

/**
 * Page every embedding wiki hosts at its origin's root for sign-ins whose popup lost `window.opener` (the provider's page sent a
 * `Cross-Origin-Opener-Policy`; Google does). The Worker redirects such a popup there with the result in the fragment
 * (`#cms-signin=<JSON { r, msg }>`); the page loads the embed loader, which passes the result on to the waiting wiki tab
 * on BroadcastChannel `cms-contrib-signin`. The tab accepts it only when `r` is its own attempt's id.
 */
export const CONTRIB_SIGNIN_CALLBACK_PATH = '/cms-signin/'
export const CONTRIB_SIGNIN_HASH = 'cms-signin'
export const CONTRIB_SIGNIN_CHANNEL = 'cms-contrib-signin'
/** The wiki tab's id for one sign-in attempt (`r`), echoed back to the callback page. */
export const CONTRIB_SIGNIN_ID_RE = /^[A-Za-z0-9_-]{22,64}$/
