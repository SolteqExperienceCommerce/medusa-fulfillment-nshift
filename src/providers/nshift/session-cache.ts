/**
 * Short-lived cache that lets one nShift session and one delivery-options response
 * serve every call Medusa makes for the same checkout context.
 *
 * Medusa calls `calculatePrice` once per calculated shipping option and then calls
 * `validateFulfillmentData` for the selected one. Without this cache each of those
 * calls created a brand new nShift session, so the session recorded on the shipping
 * method was never the session the price came from — and a five-option checkout
 * page cost eleven nShift round trips.
 *
 * In-flight promises are cached too, so concurrent callers share a single request.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500
  ) {}

  /** Returns the cached value for `key`, or runs `factory` and caches its result. */
  resolve(key: string, factory: () => Promise<T>): Promise<T> {
    const now = Date.now()
    const cached = this.entries.get(key)

    if (cached && cached.expiresAt > now) {
      return cached.value
    }

    const pending = factory()
    this.entries.set(key, { value: pending, expiresAt: now + this.ttlMs })

    // Never cache a failure, and make sure a rejection here is not treated as
    // unhandled — the caller still receives (and handles) the same promise.
    pending.catch(() => {
      if (this.entries.get(key)?.value === pending) {
        this.entries.delete(key)
      }
    })

    this.prune(now)

    return pending
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key)
      }
    }

    // Map iteration is insertion-ordered, so this evicts the oldest entries first.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) {
        break
      }
      this.entries.delete(oldest.value)
    }
  }
}
