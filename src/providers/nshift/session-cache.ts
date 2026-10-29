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

  /**
   * Stores an already-known value under `key` unless a live entry exists, so a later
   * `resolve` for an equivalent lookup in this process, within the TTL, is served
   * without calling nShift again.
   */
  prime(key: string, value: T): void {
    const now = Date.now()
    const cached = this.entries.get(key)

    if (cached && cached.expiresAt > now) {
      return
    }

    this.entries.set(key, { value: Promise.resolve(value), expiresAt: now + this.ttlMs })
    this.prune(now)
  }

  /** Drops the entry for `key`, so the next `resolve` runs its factory. */
  delete(key: string): void {
    this.entries.delete(key)
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

/**
 * A `Map` that keeps at most `maxEntries` keys, evicting the least recently set
 * one first. Used for per-process bookkeeping that must not grow without bound.
 */
export class BoundedMap<V> {
  private readonly entries = new Map<string, V>()

  constructor(readonly maxEntries: number) {}

  get(key: string): V | undefined {
    return this.entries.get(key)
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get size(): number {
    return this.entries.size
  }

  /** Sets `key` and marks it the most recently used. */
  set(key: string, value: V): void {
    // Re-inserting keeps the Map ordered by recency for the eviction below.
    this.entries.delete(key)
    this.entries.set(key, value)

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) {
        break
      }
      this.entries.delete(oldest.value)
    }
  }

  delete(key: string): void {
    this.entries.delete(key)
  }
}
