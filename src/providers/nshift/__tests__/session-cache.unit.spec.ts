import { BoundedMap, TtlCache } from "../session-cache"

describe("TtlCache", () => {
  afterEach(() => jest.useRealTimers())

  it("shares one in-flight factory call per key", async () => {
    const cache = new TtlCache<number>(1_000)
    const factory = jest.fn().mockResolvedValue(1)

    const [a, b] = await Promise.all([cache.resolve("k", factory), cache.resolve("k", factory)])

    expect([a, b]).toEqual([1, 1])
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("forgets a deleted key", async () => {
    const cache = new TtlCache<number>(1_000)
    await cache.resolve("k", async () => 1)

    cache.delete("k")

    await expect(cache.resolve("k", async () => 2)).resolves.toBe(2)
  })

  describe("prime", () => {
    it("serves a primed value without running the factory", async () => {
      const cache = new TtlCache<string>(1_000)
      const factory = jest.fn().mockResolvedValue("fetched")

      cache.prime("k", "primed")

      await expect(cache.resolve("k", factory)).resolves.toBe("primed")
      expect(factory).not.toHaveBeenCalled()
    })

    it("does not overwrite a live entry", async () => {
      const cache = new TtlCache<string>(1_000)
      await cache.resolve("k", async () => "first")

      cache.prime("k", "second")

      await expect(cache.resolve("k", async () => "factory")).resolves.toBe("first")
    })

    it("replaces an expired entry", async () => {
      jest.useFakeTimers()
      const cache = new TtlCache<string>(1_000)
      await cache.resolve("k", async () => "first")

      jest.advanceTimersByTime(1_001)
      cache.prime("k", "second")

      await expect(cache.resolve("k", async () => "factory")).resolves.toBe("second")
    })

    it("respects the entry cap, evicting the oldest entry first", async () => {
      const cache = new TtlCache<string>(1_000, 2)

      cache.prime("a", "A")
      cache.prime("b", "B")
      cache.prime("c", "C")

      const factory = jest.fn().mockResolvedValue("refetched")
      await expect(cache.resolve("a", factory)).resolves.toBe("refetched")
      // Resolving "a" again evicted "b"; "c" is still cached.
      await expect(cache.resolve("c", factory)).resolves.toBe("C")
      expect(factory).toHaveBeenCalledTimes(1)
    })
  })
})

describe("BoundedMap", () => {
  it("evicts the least recently set key once over its cap", () => {
    const map = new BoundedMap<string>(2)

    map.set("a", "1")
    map.set("b", "2")
    map.set("a", "1b") // refreshes "a", so "b" is now the oldest
    map.set("c", "3")

    expect(map.size).toBe(2)
    expect(map.has("b")).toBe(false)
    expect(map.get("a")).toBe("1b")
    expect(map.get("c")).toBe("3")
  })

  it("deletes keys", () => {
    const map = new BoundedMap<string>(2)
    map.set("a", "1")

    map.delete("a")

    expect(map.get("a")).toBeUndefined()
    expect(map.size).toBe(0)
  })
})
