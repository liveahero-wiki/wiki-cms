/** A provider could not be reached or answered nonsense (not "the user is ineligible"): callers ask the user to retry. */
export class ProviderUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProviderUnavailable'
  }
}
