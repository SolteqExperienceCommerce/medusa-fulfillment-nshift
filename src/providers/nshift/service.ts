import {
  CalculateShippingOptionPriceDTO,
  CalculatedShippingOptionPrice,
  CartPropsForFulfillment,
  CreateFulfillmentResult,
  CreateShippingOptionDTO,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  Logger,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import { AbstractFulfillmentProviderService, MedusaError } from "@medusajs/framework/utils"
import { createHash } from "node:crypto"
import { NShiftApiError, NShiftClient } from "./client"
import {
  AddressLike,
  NormalizedMethodData,
  PackageTotals,
  buildPackages,
  buildReceiver,
  buildSubShipment,
  describeMissingReceiverFields,
  isReceiverDeliverable,
  normalizeMethodData,
  readVariant,
  ShippableItem,
  sumAddonPrices,
  toCalculatedPriceData,
  toFulfillmentOptionData,
  toNumber,
  toTrimmedString,
} from "./mappers"
import { BoundedMap, TtlCache } from "./session-cache"
import {
  FetchDeliveryOptionsResponse,
  FetchSplitDeliveryOptionsResponse,
  NShiftCalculatedShippingOptionPrice,
  NShiftContextPayload,
  NShiftDeliveryOption,
  NShiftFulfillmentData,
  NShiftMethodData,
  NShiftOptions,
  NShiftPackage,
  NShiftPickupPoint,
  NShiftReceiver,
  NShiftSplitShipmentSelection,
  NShiftTimeSlot,
  PartialShipmentResponse,
} from "./types"

type InjectedDependencies = {
  logger: Logger
}

/**
 * A session plus the delivery options that were fetched inside it. Split sessions
 * also carry the sub-shipment the options belong to; their options are normalised
 * into the single-shipment response shape so both modes share the lookup code.
 *
 * Cached results are shared by every caller for the same context, so they are
 * read-only (and frozen at the top levels, see {@link freezeResolved}).
 */
type ResolvedDeliveryOptions = Readonly<{
  sessionId: string
  subShipmentId?: string
  response: Readonly<FetchDeliveryOptionsResponse>
}>

/**
 * A session the storefront already holds: the ids `calculatePrice` returned in
 * `calculated_price.nshift`, sent back as shipping-method `data`.
 */
type PinnedSession = {
  sessionId: string
  subShipmentId?: string
}

/** A booking's selection, before the session it is booked in is known. */
type NShiftShipmentSelection = Omit<NShiftSplitShipmentSelection, "subShipmentId">

/** A partial shipment and the session (and sub-shipment) it was booked in. */
type BookedShipment = PinnedSession & {
  shipment: PartialShipmentResponse
}

/**
 * A session created at fulfillment time, plus what nShift now charges for the
 * selected option and addons (undefined when nShift returned no price).
 */
type BookingSession = {
  session: PinnedSession
  price?: number
}

/** Everything needed to talk to nShift for one checkout context. */
type NShiftRequestContext = {
  cacheKey: string
  /** The cart id the context belongs to; unset outside a cart (e.g. at fulfillment). */
  scope?: string
  payload: NShiftContextPayload
  totals: PackageTotals
  receiver: NShiftReceiver
  packages: NShiftPackage[]
  currencyCode: string
}

const DEFAULT_LANGUAGE_CODE = "en"
const DEFAULT_LOCALE_ID = "en-GB"
const DEFAULT_CURRENCY = "EUR"
const DEFAULT_OPTIONS_CACHE_TTL_MS = 30_000
/**
 * Upper bound on the sessions whose last synced context, and whose cart, this
 * process remembers. Forgetting one costs at most one extra session update and
 * options fetch, or lets a pin through unchecked (as for a session another process
 * created).
 */
const MAX_TRACKED_SESSIONS = 2_000

/**
 * Booking statuses after which the shipment is booked once more in a new session.
 * A 4xx means nShift refused the request, so no shipment exists yet and booking
 * again cannot create a duplicate; `createBookingSession` re-checks the option,
 * pickup point and time slot in the new session. nShift documents no issue code
 * for an expired session, so the status is all there is to go by.
 */
const REBOOKABLE_STATUSES: ReadonlySet<number> = new Set([400, 404, 410])

/**
 * Freezes a cached result (and its options list) so a caller cannot change what
 * every later lookup for the same context receives. The nShift objects inside are
 * left as they are: they are passed through to Medusa, which owns them from there.
 */
const freezeResolved = (resolved: ResolvedDeliveryOptions): ResolvedDeliveryOptions => {
  Object.freeze(resolved.response.options)
  Object.freeze(resolved.response)
  return Object.freeze(resolved)
}

/** Difference between two prices, without floating-point noise. */
const priceDifference = (next: number, previous: number): number =>
  Number((next - previous).toFixed(6))

class NShiftProviderService extends AbstractFulfillmentProviderService {
  static identifier = "nshift"

  protected readonly options_: NShiftOptions
  protected readonly logger_: Logger
  protected readonly client: NShiftClient

  private readonly deliveryOptionsCache: TtlCache<ResolvedDeliveryOptions>
  /**
   * Last options cache key each nShift session (and sub-shipment) was created or
   * updated with, so a pinned session is only updated when its context changed.
   * Per process, like the options cache.
   */
  private readonly syncedSessions = new BoundedMap<string>(MAX_TRACKED_SESSIONS)
  /**
   * The cart (`context.id`) each session this process resolved was issued for.
   * Pinned ids come from anonymous storefront callers, so a session known to
   * belong to another cart is never reused. Per process: an unknown session (from
   * another instance, or from before a restart) is accepted as before.
   */
  private readonly sessionScopes = new BoundedMap<string>(MAX_TRACKED_SESSIONS)

  constructor({ logger }: InjectedDependencies, options: NShiftOptions) {
    super()

    const missing = (["client_id", "client_secret", "connection_id"] as const).filter(
      (key) => !toTrimmedString(options?.[key])
    )
    if (missing.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        `nShift fulfillment provider is missing required options: ${missing.join(", ")}.`
      )
    }

    this.options_ = options
    this.logger_ = logger
    this.client = new NShiftClient(options)
    this.deliveryOptionsCache = new TtlCache<ResolvedDeliveryOptions>(
      options.options_cache_ttl_ms ?? DEFAULT_OPTIONS_CACHE_TTL_MS
    )
  }

  // ── Configuration helpers ──

  private get languageCode(): string {
    return this.options_.language_code || DEFAULT_LANGUAGE_CODE
  }

  private get localeId(): string {
    return this.options_.locale_id || DEFAULT_LOCALE_ID
  }

  private get pricesTaxInclusive(): boolean {
    return this.options_.prices_tax_inclusive ?? true
  }

  private get splitShipments(): boolean {
    return this.options_.split_shipments === true
  }

  private get includeInConversionRate(): boolean {
    return this.options_.include_in_conversion_rate ?? true
  }

  private resolveCurrency(context: Record<string, unknown>): string {
    const fromContext = toTrimmedString(context.currency_code)
    const region = context.region
    const fromRegion =
      region && typeof region === "object"
        ? toTrimmedString((region as Record<string, unknown>).currency_code)
        : undefined

    const currency =
      fromContext ?? fromRegion ?? this.options_.default_currency ?? DEFAULT_CURRENCY

    if (!fromContext && !fromRegion) {
      this.logger_.debug(
        `[nshift] No currency in the calculation context; falling back to "${currency}".`
      )
    }

    return currency.toUpperCase()
  }

  // ── nShift context building ──

  private buildRequestContext(
    context: Record<string, unknown> & Partial<CartPropsForFulfillment>
  ): NShiftRequestContext {
    const currencyCode = this.resolveCurrency(context)
    const receiver = buildReceiver(
      (context.shipping_address ?? undefined) as AddressLike | undefined,
      this.options_
    )
    const totals = buildPackages(context.items, this.options_)
    const payload = this.toContextPayload(currencyCode, receiver, totals)

    // The cart id keeps sessions from being shared between carts even if two carts
    // happen to produce an identical payload.
    const scope = toTrimmedString(context.id)
    const cacheKey = `${scope ?? "no-cart"}:${createHash("sha1")
      .update(JSON.stringify(payload))
      .digest("hex")}`

    return {
      cacheKey,
      ...(scope ? { scope } : {}),
      payload,
      totals,
      receiver,
      packages: totals.packages,
      currencyCode,
    }
  }

  private toContextPayload(
    currencyCode: string,
    receiver: NShiftReceiver,
    totals: PackageTotals
  ): NShiftContextPayload {
    const { packages, totalWeightKg, totalVolumeCm3, totalPrice } = totals

    return {
      currencyCode,
      languageCode: this.languageCode,
      localeId: this.localeId,
      receiver,
      ...(packages.length ? { packages } : {}),
      ...(totalWeightKg === undefined ? {} : { totalWeightKg }),
      ...(totalVolumeCm3 === undefined ? {} : { totalVolumeCm3 }),
      ...(totalPrice === undefined ? {} : { totalPrice }),
    }
  }

  /**
   * A storefront that already holds an nShift session (and, for split sessions, a
   * sub-shipment) sends it back as method data so the customer keeps the options
   * they were shown. A sub-shipment id always means a split session; a bare session
   * id only identifies a single-shipment session, because in split mode nothing
   * tells us which sub-shipment this shipping method maps to.
   */
  private readPinnedSession(method: NormalizedMethodData): PinnedSession | undefined {
    if (!method.session_id) {
      return undefined
    }
    if (method.sub_shipment_id) {
      return { sessionId: method.session_id, subShipmentId: method.sub_shipment_id }
    }
    return this.splitShipments ? undefined : { sessionId: method.session_id }
  }

  /**
   * Split and single sessions are different nShift resources, so they must never
   * share a cache entry; the pinned ids and store change what nShift returns.
   */
  private optionsCacheKey(
    request: NShiftRequestContext,
    pinned: PinnedSession | undefined,
    preselectedStoreId: string | undefined
  ): string {
    return [
      this.splitShipments ? "split" : "single",
      pinned?.sessionId ?? "",
      pinned?.subShipmentId ?? "",
      preselectedStoreId ?? "",
      request.cacheKey,
    ].join("|")
  }

  /**
   * Resolves the session and delivery options for one checkout context, reusing
   * them for every option of that context (see {@link TtlCache}). A pinned session
   * is used when nShift still accepts it; otherwise a new session is created.
   *
   * The result is also cached under the key a lookup pinned to the resolved
   * session will use. The storefront sends the ids from `calculated_price.nshift`
   * back as method data, so `validateFulfillmentData` and later cart refreshes for
   * the same context, on the same process and within `options_cache_ttl_ms`, reuse
   * this result instead of asking nShift again.
   */
  private async resolveDeliveryOptions(
    request: NShiftRequestContext,
    method: NormalizedMethodData
  ): Promise<ResolvedDeliveryOptions> {
    const pinned = this.acceptPinnedSession(request, this.readPinnedSession(method))
    const preselectedStoreId = method.preselected_store_id
    const cacheKey = this.optionsCacheKey(request, pinned, preselectedStoreId)

    if (pinned && this.syncedSessions.get(this.sessionSyncKey(pinned)) !== cacheKey) {
      // A live entry for this key was fetched while the session held this context,
      // but the session has since been moved to another one (cart A -> B -> A), or
      // its sync state was evicted. Drop the entry so the session is brought back
      // to this context before its options are served. When the session is in sync
      // this is skipped and the cached options are served without an nShift call.
      this.deliveryOptionsCache.delete(cacheKey)
    }

    return this.deliveryOptionsCache.resolve(cacheKey, async () => {
      const resolved = freezeResolved(
        await this.fetchOrCreateSession(request, pinned, preselectedStoreId)
      )

      const resolvedKey = this.optionsCacheKey(
        request,
        { sessionId: resolved.sessionId, subShipmentId: resolved.subShipmentId },
        preselectedStoreId
      )
      this.markSessionSynced(resolved, resolvedKey)
      if (request.scope) {
        this.sessionScopes.set(resolved.sessionId, request.scope)
      }
      if (resolvedKey !== cacheKey) {
        this.deliveryOptionsCache.prime(resolvedKey, resolved)
      }

      return resolved
    })
  }

  /**
   * Pinned ids come from anonymous storefront callers. A session this process
   * issued for another cart is ignored, so a caller cannot read or update another
   * cart's session by sending its id. A session this process does not know is
   * accepted, since it may come from another instance or from before a restart.
   * A context without a cart id (order, claim, exchange, draft-order refresh)
   * has no scope to compare, so it is never rejected.
   */
  private acceptPinnedSession(
    request: NShiftRequestContext,
    pinned: PinnedSession | undefined
  ): PinnedSession | undefined {
    if (!pinned) {
      return undefined
    }

    const owner = this.sessionScopes.get(pinned.sessionId)
    // Only a cart id is comparable: order/claim/exchange refreshes spread the order
    // into the context, so their `id` is an `order_…` id, never the issuing cart's.
    if (owner === undefined || !request.scope?.startsWith("cart_") || owner === request.scope) {
      return pinned
    }

    this.logger_.warn(
      `[nshift] Ignoring pinned session ${pinned.sessionId}: it was issued for a ` +
        `different cart. Resolving a session for this cart instead.`
    )
    return undefined
  }

  private async fetchOrCreateSession(
    request: NShiftRequestContext,
    pinned: PinnedSession | undefined,
    preselectedStoreId: string | undefined
  ): Promise<ResolvedDeliveryOptions> {
    if (pinned) {
      try {
        return await this.fetchInPinnedSession(request, pinned, preselectedStoreId)
      } catch (error) {
        if (!(error instanceof NShiftApiError) || !REBOOKABLE_STATUSES.has(error.status)) {
          throw error
        }
        // nShift reports an unknown/expired session and a context it rejects with
        // the same statuses, and its issue codes do not tell them apart reliably.
        this.logger_.warn(
          `[nshift] nShift rejected the request for session ${pinned.sessionId}` +
            `${pinned.subShipmentId ? ` / sub-shipment ${pinned.subShipmentId}` : ""} ` +
            `(${error.status}): the session may have expired or the checkout context ` +
            `was not accepted. Creating a new session instead.`
        )
      }
    }

    return this.splitShipments
      ? this.createSplitSessionWithOptions(request, preselectedStoreId)
      : this.createSessionWithOptions(request, preselectedStoreId)
  }

  private sessionSyncKey(session: PinnedSession): string {
    return `${session.sessionId}|${session.subShipmentId ?? ""}`
  }

  /** Records that `session` now holds the context behind `cacheKey`. */
  private markSessionSynced(session: PinnedSession, cacheKey: string): void {
    this.syncedSessions.set(this.sessionSyncKey(session), cacheKey)
  }

  /**
   * Brings a pinned session in line with the current checkout context (receiver,
   * packages, preselected store) before options are fetched in it. Skipped when
   * this provider already created or updated the session with the same context.
   *
   * Every split session in the Medusa-only flow is a one-sub-shipment session this
   * provider created, so replacing its sub-shipments with that single sub-shipment
   * (carrying its id) keeps its identity.
   */
  private async syncPinnedSession(
    request: NShiftRequestContext,
    pinned: PinnedSession,
    preselectedStoreId: string | undefined
  ): Promise<void> {
    const cacheKey = this.optionsCacheKey(request, pinned, preselectedStoreId)
    const syncKey = this.sessionSyncKey(pinned)
    if (this.syncedSessions.get(syncKey) === cacheKey) {
      return
    }

    // Claimed before the update, so concurrent lookups for the same context share
    // the in-flight options request instead of dropping it and updating again.
    this.markSessionSynced(pinned, cacheKey)
    try {
      await this.updatePinnedSession(request, pinned, preselectedStoreId)
    } catch (error) {
      if (this.syncedSessions.get(syncKey) === cacheKey) {
        this.syncedSessions.delete(syncKey)
      }
      throw error
    }
  }

  private async updatePinnedSession(
    request: NShiftRequestContext,
    pinned: PinnedSession,
    preselectedStoreId: string | undefined
  ): Promise<void> {
    if (pinned.subShipmentId) {
      await this.client.updateSplitSession(pinned.sessionId, {
        currencyCode: request.payload.currencyCode,
        languageCode: request.payload.languageCode,
        localeId: request.payload.localeId,
        receiver: request.receiver,
        subShipments: [
          {
            ...buildSubShipment(request.totals, { preselectedStoreId }),
            subShipmentId: pinned.subShipmentId,
          },
        ],
        includeInConversionRate: this.includeInConversionRate,
      })
    } else {
      await this.client.updateSession(pinned.sessionId, {
        ...request.payload,
        ...(preselectedStoreId ? { preselectedStoreId } : {}),
        includeInConversionRate: this.includeInConversionRate,
      })
    }
  }

  private async fetchInPinnedSession(
    request: NShiftRequestContext,
    pinned: PinnedSession,
    preselectedStoreId: string | undefined
  ): Promise<ResolvedDeliveryOptions> {
    await this.syncPinnedSession(request, pinned, preselectedStoreId)

    if (pinned.subShipmentId) {
      return this.fetchSplitOptions(
        request,
        pinned.sessionId,
        pinned.subShipmentId,
        preselectedStoreId
      )
    }

    const response = await this.client.fetchDeliveryOptions(pinned.sessionId, {
      ...request.payload,
      ...(preselectedStoreId ? { preselectedStoreId } : {}),
    })
    this.warnOnBlockingIssues(response)

    return { sessionId: response.sessionId || pinned.sessionId, response }
  }

  private async createSessionWithOptions(
    request: NShiftRequestContext,
    preselectedStoreId: string | undefined
  ): Promise<ResolvedDeliveryOptions> {
    const session = await this.client.createSession({
      ...request.payload,
      includeInConversionRate: this.includeInConversionRate,
    })

    const response = await this.client.fetchDeliveryOptions(session.sessionId, {
      ...request.payload,
      ...(preselectedStoreId ? { preselectedStoreId } : {}),
    })
    this.warnOnBlockingIssues(response)

    return { sessionId: response.sessionId || session.sessionId, response }
  }

  /**
   * Medusa prices and validates each shipping method with only the items of its own
   * shipping profile, so in split mode each method maps to exactly one sub-shipment.
   */
  private async createSplitSessionWithOptions(
    request: NShiftRequestContext,
    preselectedStoreId: string | undefined
  ): Promise<ResolvedDeliveryOptions> {
    const session = await this.client.createSplitSession({
      currencyCode: request.payload.currencyCode,
      languageCode: request.payload.languageCode,
      localeId: request.payload.localeId,
      receiver: request.receiver,
      subShipments: [buildSubShipment(request.totals, { preselectedStoreId })],
      includeInConversionRate: this.includeInConversionRate,
    })

    // The first sub-shipment id equals the session id, which covers a response
    // that omits the list.
    const subShipmentId = session.subShipments?.[0]?.subShipmentId ?? session.sessionId

    return this.fetchSplitOptions(
      request,
      session.sessionId,
      subShipmentId,
      preselectedStoreId
    )
  }

  private async fetchSplitOptions(
    request: NShiftRequestContext,
    sessionId: string,
    subShipmentId: string,
    preselectedStoreId: string | undefined
  ): Promise<ResolvedDeliveryOptions> {
    const split = await this.client.fetchSplitDeliveryOptions(sessionId, {
      currencyCode: request.payload.currencyCode,
      languageCode: request.payload.languageCode,
      localeId: request.payload.localeId,
      receiver: request.receiver,
      subShipments: [
        {
          ...buildSubShipment(request.totals, { preselectedStoreId }),
          subShipmentId,
        },
      ],
    })

    const response = this.toSingleResponse(split, subShipmentId)
    this.warnOnBlockingIssues(response)

    return {
      sessionId: split.sessionId || sessionId,
      subShipmentId: response.subShipmentId ?? subShipmentId,
      response,
    }
  }

  private toSingleResponse(
    split: FetchSplitDeliveryOptionsResponse,
    subShipmentId: string
  ): FetchDeliveryOptionsResponse {
    const subShipments = split.subShipments ?? []
    const match =
      subShipments.find((entry) => entry.subShipmentId === subShipmentId) ??
      (subShipments.length === 1 ? subShipments[0] : undefined)

    if (!match) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `nShift returned no delivery options for sub-shipment ${subShipmentId}.`
      )
    }

    return {
      optionsVersion: split.optionsVersion,
      sessionId: split.sessionId,
      subShipmentId: match.subShipmentId,
      checkoutId: match.checkoutId,
      checkoutVersion: match.checkoutVersion,
      language: split.language,
      options: match.options ?? [],
      addons: match.addons,
      hiddenAddons: match.hiddenAddons,
      fields: match.fields,
      categories: match.categories,
      issues: match.issues,
    }
  }

  private warnOnBlockingIssues(response: FetchDeliveryOptionsResponse): void {
    const blockingIssues = (response.issues ?? []).filter(
      (issue) => issue.severity === "ERROR"
    )
    if (blockingIssues.length) {
      this.logger_.warn(
        `[nshift] Delivery options returned blocking issues: ${JSON.stringify(
          blockingIssues
        )}`
      )
    }
  }

  private findOption(
    response: FetchDeliveryOptionsResponse,
    optionId: string
  ): NShiftDeliveryOption | undefined {
    return (response.options ?? []).find(
      (option) => option.optionId === optionId && option.valid !== false
    )
  }

  private readOptionId(optionData: Record<string, unknown>): string {
    const optionId =
      toTrimmedString(optionData.option_id) ?? toTrimmedString(optionData.id)

    if (!optionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "This shipping option has no nShift delivery option attached. Re-create it in " +
          "the admin and pick an nShift fulfillment option so its `data.option_id` is set."
      )
    }

    return optionId
  }

  // ═══════════════════════════════════════════════════════════════════
  // AbstractFulfillmentProviderService
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Lists the nShift delivery options an admin can attach to a shipping option.
   *
   * nShift only returns delivery options for a concrete receiver, so this uses
   * `default_country` / `default_postal_code` from the module options.
   */
  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    const receiver = buildReceiver(
      {
        country_code: this.options_.default_country,
        postal_code: this.options_.default_postal_code,
        province: this.options_.default_state,
      },
      this.options_
    )

    if (!isReceiverDeliverable(receiver)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `nShift needs a receiver ${describeMissingReceiverFields(receiver).join(
          " and "
        )} to list delivery options. Set default_country and default_postal_code ` +
          `(e.g. NSHIFT_DEFAULT_COUNTRY="FI", NSHIFT_DEFAULT_POSTAL_CODE="00100") ` +
          `in the provider options.`
      )
    }

    const payload: NShiftContextPayload = {
      currencyCode: (this.options_.default_currency ?? DEFAULT_CURRENCY).toUpperCase(),
      languageCode: this.languageCode,
      localeId: this.localeId,
      receiver,
    }

    const session = await this.client.createSession({
      ...payload,
      includeInConversionRate: false,
    })
    const response = await this.client.fetchDeliveryOptions(session.sessionId, payload)

    const options = (response.options ?? [])
      .filter((option) => option.valid !== false)
      .map(toFulfillmentOptionData)

    if (!options.length) {
      this.logger_.warn(
        `[nshift] No valid delivery options for country "${receiver.country}" / ` +
          `postal code "${receiver.postalCode}". Check the carriers and delivery ` +
          `options on the Checkout configuration behind connection_id. ` +
          `Issues: ${JSON.stringify(response.issues ?? [])}`
      )
    }

    return options
  }

  /** Every nShift delivery option is priced by the Checkout API, never by Medusa. */
  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return true
  }

  /**
   * Prices one delivery option for the current cart.
   *
   * This method never throws. Whatever goes wrong — an incomplete address, a route
   * the carrier does not serve, an option nShift returns without a price, an nShift
   * outage — the returned price carries no `calculated_amount`. Medusa reads that as
   * "not available in this context": `refreshCartShippingMethodsWorkflow` drops the
   * shipping method and `validateCartShippingOptionsPriceStep` refuses an explicit
   * selection, so the rest of the checkout keeps working with the other providers.
   *
   * Returning `0` would silently hand the customer free shipping, and returning
   * another option's price (the previous fallback behaviour) would charge them for a
   * different carrier.
   */
  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<NShiftCalculatedShippingOptionPrice | CalculatedShippingOptionPrice> {
    try {
      return await this.calculatePriceOrThrow(optionData, data, context)
    } catch (error) {
      this.logger_.error(
        `[nshift] Could not price delivery option ` +
          `${toTrimmedString(optionData?.option_id) ?? "<unknown>"}; it will be ` +
          `offered as unavailable. ${this.describeError(error)}`
      )
      return this.unavailablePrice()
    }
  }

  /**
   * On success the price also carries `nshift`: the session to pin and the option's
   * pickup points, time slots, addons and fields. Medusa returns the whole result as
   * the shipping option's `calculated_price`, which is how a storefront gets this
   * data from `listCartOptions` / `calculate` without a custom route.
   */
  private async calculatePriceOrThrow(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<NShiftCalculatedShippingOptionPrice | CalculatedShippingOptionPrice> {
    const optionId = this.readOptionId(optionData)
    const method = normalizeMethodData(data)
    const request = this.buildRequestContext(context)

    if (!isReceiverDeliverable(request.receiver)) {
      this.logger_.debug(
        `[nshift] Skipping price calculation for option ${optionId}: the cart address ` +
          `is missing ${describeMissingReceiverFields(request.receiver).join(" and ")}.`
      )
      return this.unavailablePrice()
    }

    const resolved = await this.resolveDeliveryOptions(request, method)
    const option = this.findOption(resolved.response, optionId)
    const { response } = resolved

    if (!option) {
      this.logger_.info(
        `[nshift] Delivery option ${optionId} is not available for ` +
          `${request.receiver.country} ${request.receiver.postalCode}. ` +
          `Issues: ${JSON.stringify(response.issues ?? [])}`
      )
      return this.unavailablePrice()
    }

    const basePrice = toNumber(option.price)
    if (basePrice === undefined) {
      // A priceless option cannot be charged for, so treat it as unavailable rather
      // than assuming it is free.
      this.logger_.warn(
        `[nshift] Delivery option ${optionId} ("${option.name}") came back without a ` +
          `price; offering it as unavailable.`
      )
      return this.unavailablePrice()
    }

    const addonsPrice = sumAddonPrices(option, method.addons)

    return {
      calculated_amount: basePrice + addonsPrice,
      is_calculated_price_tax_inclusive: this.pricesTaxInclusive,
      nshift: toCalculatedPriceData(resolved, option, {
        basePrice,
        addonsPrice,
        currencyCode: request.currencyCode,
      }),
    }
  }

  /**
   * Builds the "no price available" result.
   *
   * Medusa detects unavailability with `isDefined(calculated_price.calculated_amount)`,
   * but `CalculatedShippingOptionPrice` types the field as required. Deleting the key
   * through `Reflect` expresses the absence without an unchecked cast.
   */
  private unavailablePrice(): CalculatedShippingOptionPrice {
    const price: CalculatedShippingOptionPrice = {
      calculated_amount: 0,
      is_calculated_price_tax_inclusive: this.pricesTaxInclusive,
    }
    Reflect.deleteProperty(price, "calculated_amount")
    return price
  }

  private describeError(error: unknown): string {
    if (error instanceof NShiftApiError) {
      return `nShift responded ${error.status}: ${error.message}`
    }
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`
    }
    return String(error)
  }

  /**
   * Validates the customer's selection and returns the data persisted on the
   * shipping method. This is where the session that produced the price is pinned,
   * so the partial shipment created later refers to the same nShift session.
   */
  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: ValidateFulfillmentDataContext
  ): Promise<NShiftMethodData> {
    const optionId = this.readOptionId(optionData)
    const method = normalizeMethodData(data)
    const request = this.buildRequestContext(context)

    if (!isReceiverDeliverable(request.receiver)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `nShift needs a shipping address with a ${describeMissingReceiverFields(
          request.receiver
        ).join(" and ")} before a delivery option can be selected.`
      )
    }

    const { sessionId, subShipmentId, response } = await this.resolveDeliveryOptions(
      request,
      method
    )
    const option = this.findOption(response, optionId)

    if (!option) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `nShift no longer offers delivery option ${optionId} for ` +
          `${request.receiver.country} ${request.receiver.postalCode}. ` +
          `Please choose another shipping method.`
      )
    }

    const basePrice = toNumber(option.price)
    if (basePrice === undefined) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `nShift returned delivery option ${option.optionId} without a price, so it ` +
          `cannot be selected. Please choose another shipping method.`
      )
    }

    const pickupPoint = this.resolvePickupPoint(option, method)
    const timeSlot = this.resolveTimeSlot(option, method)
    this.assertAddonsExist(option, method)

    const optionInfo = toFulfillmentOptionData(option)

    // A stale sub-shipment id (e.g. after falling back from a rejected split session
    // to a single one) would route the fulfillment to the wrong endpoint later.
    const { sub_shipment_id: _staleSnake, subShipmentId: _staleCamel, ...rest } = data

    const validated: NShiftMethodData = {
      // Preserve anything the storefront sent so consumers relying on extra keys
      // (e.g. widget payload fragments) keep working.
      ...rest,
      session_id: sessionId,
      ...(subShipmentId ? { sub_shipment_id: subShipmentId } : {}),
      option_id: option.optionId,
      carrier_id: optionInfo.carrier_id,
      carrier_name: optionInfo.carrier_name,
      carrier_product_id: optionInfo.carrier_product_id,
      carrier_product_name: optionInfo.carrier_product_name,
      currency_code: request.currencyCode,
      price: basePrice + sumAddonPrices(option, method.addons),
      ...(pickupPoint
        ? { pickup_point_id: pickupPoint.pickupPointId, pickup_point: pickupPoint }
        : {}),
      ...(timeSlot ? { time_slot_id: timeSlot.timeSlotId, time_slot: timeSlot } : {}),
      ...(method.addons.length ? { addons: method.addons } : {}),
      ...(method.fields.length ? { fields: method.fields } : {}),
      ...(option.deliveryTime ? { delivery_time: option.deliveryTime } : {}),
    }

    return validated
  }

  private resolvePickupPoint(
    option: NShiftDeliveryOption,
    method: NormalizedMethodData
  ): NShiftPickupPoint | undefined {
    const pickupPoints = option.pickupPoints ?? []

    if (method.pickup_point_id) {
      const selected = pickupPoints.find(
        (point) => point.pickupPointId === method.pickup_point_id
      )
      if (!selected) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Pickup point ${method.pickup_point_id} is not available for nShift ` +
            `delivery option ${option.optionId}.`
        )
      }
      return selected
    }

    // nShift only auto-assigns a pickup point when the option allows a default one.
    if (pickupPoints.length && option.noDefaultPickupPoint) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `nShift delivery option ${option.optionId} requires a pickup point. Send it ` +
          `as \`data.pickup_point_id\` when adding the shipping method.`
      )
    }

    return undefined
  }

  private resolveTimeSlot(
    option: NShiftDeliveryOption,
    method: NormalizedMethodData
  ): NShiftTimeSlot | undefined {
    if (!method.time_slot_id) {
      return undefined
    }

    const selected = (option.timeSlots ?? []).find(
      (slot) => slot.timeSlotId === method.time_slot_id
    )
    if (!selected) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Time slot ${method.time_slot_id} is not available for nShift delivery ` +
          `option ${option.optionId}.`
      )
    }

    return selected
  }

  private assertAddonsExist(
    option: NShiftDeliveryOption,
    method: NormalizedMethodData
  ): void {
    if (!method.addons.length) {
      return
    }

    const available = new Set(
      [...(option.addons ?? []), ...(option.hiddenAddons ?? [])].map(
        (addon) => addon.addonId
      )
    )
    const unknown = method.addons
      .map((addon) => addon.addonId)
      .filter((addonId) => !available.has(addonId))

    if (unknown.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Addon(s) ${unknown.join(", ")} are not available for nShift delivery ` +
          `option ${option.optionId}.`
      )
    }
  }

  /**
   * Creates the nShift partial shipment for a fulfillment, forwarding the pickup
   * point, time slot, addons and custom fields the customer selected at checkout.
   */
  async createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
  ): Promise<CreateFulfillmentResult> {
    const method = normalizeMethodData(data)

    // The shipping option's data is not passed here, so a method without its
    // option cannot be recovered. A missing session can: it is created below.
    const optionId = method.option_id
    if (!optionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "nShift option_id is required to create a fulfillment. Ensure the shipping " +
          "method was created through this provider during checkout."
      )
    }

    const receiver = buildReceiver(
      (order?.shipping_address ??
        fulfillment.delivery_address ??
        undefined) as AddressLike | undefined,
      this.options_
    )

    if (!isReceiverDeliverable(receiver)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `The order's shipping address is missing a ${describeMissingReceiverFields(
          receiver
        ).join(" and ")}, which nShift requires to book a shipment.`
      )
    }

    const totals = this.buildFulfillmentTotals(items, order)
    const selection: NShiftShipmentSelection = {
      orderId: toTrimmedString(order?.id) ?? String(order?.display_id ?? ""),
      optionId,
      packages: totals.packages,
      ...(method.pickup_point_id ? { pickupPointId: method.pickup_point_id } : {}),
      ...(method.time_slot_id ? { timeSlotId: method.time_slot_id } : {}),
      ...(method.addons.length ? { addons: method.addons } : {}),
      ...(method.fields.length ? { fields: method.fields } : {}),
    }

    // The stored ids say which kind of session priced the method: only a split
    // session has a sub-shipment, and only the split endpoint can book it. The
    // current `split_shipments` setting does not matter, so turning it on later
    // never sends a single session to the split endpoint (or the reverse).
    const createFreshSession = (split: boolean) =>
      this.createBookingSession(
        receiver,
        totals,
        this.resolveCurrency({
          currency_code: toTrimmedString(data?.currency_code) ?? order?.currency_code,
        }),
        method,
        split
      )

    let booked: BookedShipment
    // Set when the shipment is booked in a session created here, whose price may
    // differ from the one the customer paid.
    let rebookedPrice: number | undefined
    if (!method.session_id) {
      // Medusa providers create a missing third-party resource lazily rather than
      // failing (e.g. a method created before this provider stored sessions). With
      // no stored ids to go by, the configured mode decides the session kind.
      this.logger_.warn(
        `[nshift] Shipping method for order ${selection.orderId} has no nShift ` +
          `session; creating one to book delivery option ${optionId}.`
      )
      const fresh = await createFreshSession(this.splitShipments)
      rebookedPrice = fresh.price
      booked = await this.bookShipment(fresh.session, receiver, selection)
    } else {
      const stored: PinnedSession = {
        sessionId: method.session_id,
        ...(method.sub_shipment_id ? { subShipmentId: method.sub_shipment_id } : {}),
      }

      try {
        booked = await this.bookShipment(stored, receiver, selection)
      } catch (error) {
        // Only a 4xx is retried: nShift refused the request, so no shipment exists.
        // A timeout (status 0) or a 5xx may arrive after nShift already created the
        // shipment, and booking again would then create a second one. Those are
        // left to staff, who should check nShift before retrying (see the README).
        if (!this.isRebookableError(error)) {
          throw error
        }

        // Cart refreshes only update the shipping method's amount, never its data,
        // so a session replaced while pricing stays on the method; nShift sessions
        // also expire four hours after the last interaction. Book in a fresh one.
        this.logger_.warn(
          `[nshift] nShift rejected booking order ${selection.orderId} in session ` +
            `${stored.sessionId}` +
            `${stored.subShipmentId ? ` / sub-shipment ${stored.subShipmentId}` : ""} ` +
            `with status ${error.status} (issue codes: ${this.describeIssueCodes(error)}); ` +
            `rebuilding the session and booking once more. ${this.describeError(error)}`
        )
        const fresh = await createFreshSession(!!stored.subShipmentId)
        rebookedPrice = fresh.price
        booked = await this.bookShipment(fresh.session, receiver, selection)
      }
    }

    const { shipment } = booked
    const fulfillmentData: NShiftFulfillmentData = {
      nshift_shipment_id: shipment.id,
      nshift_session_id: booked.sessionId,
      ...(booked.subShipmentId ? { nshift_sub_shipment_id: booked.subShipmentId } : {}),
      nshift_order_id: shipment.orderId,
      nshift_carrier: shipment.carrier,
      nshift_carrier_product: shipment.carrierProduct,
      ...this.describePriceDrift(selection.orderId, toNumber(data?.price), rebookedPrice),
    }

    return {
      data: { ...(data ?? {}), ...fulfillmentData },
      labels: [],
    }
  }

  private async bookShipment(
    session: PinnedSession,
    receiver: NShiftReceiver,
    selection: NShiftShipmentSelection
  ): Promise<BookedShipment> {
    const shipment = session.subShipmentId
      ? await this.createSplitShipment(session.sessionId, receiver, {
          ...selection,
          subShipmentId: session.subShipmentId,
        })
      : await this.client.createPartialShipment(
          { ...selection, sessionId: session.sessionId, receiver },
          this.options_.send_to_book_and_print
        )

    return { ...session, shipment }
  }

  private async createSplitShipment(
    sessionId: string,
    receiver: NShiftReceiver,
    selection: NShiftSplitShipmentSelection
  ): Promise<PartialShipmentResponse> {
    const result = await this.client.createSplitPartialShipments(
      { sessionId, receiver, subShipments: [selection] },
      this.options_.send_to_book_and_print
    )

    const shipment = result?.shipments?.[0]
    if (!shipment) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `nShift created no shipment for sub-shipment ${selection.subShipmentId} of ` +
          `session ${sessionId}.`
      )
    }

    return shipment
  }

  /**
   * True when a booking may be repeated in a new session: nShift answered with one
   * of {@link REBOOKABLE_STATUSES}. Timeouts and transport failures (status 0),
   * 5xx responses and anything that is not an `NShiftApiError` never qualify,
   * because nShift may have created the shipment before the failure.
   */
  private isRebookableError(error: unknown): error is NShiftApiError {
    return error instanceof NShiftApiError && REBOOKABLE_STATUSES.has(error.status)
  }

  private describeIssueCodes(error: NShiftApiError): string {
    const codes = error.issues
      .map((issue) => issue.issueCode)
      .filter((code): code is string => !!code)
    return codes.length ? codes.join(", ") : "none"
  }

  /**
   * Compares what nShift charges in a session created at fulfillment time with the
   * price stored on the shipping method. The booking goes ahead either way: the
   * customer already paid, and refusing would leave the order unshippable. A drift
   * is logged and recorded on the fulfillment so staff can follow it up.
   */
  private describePriceDrift(
    orderId: string,
    storedPrice: number | undefined,
    rebookedPrice: number | undefined
  ): Pick<NShiftFulfillmentData, "nshift_rebooked_price" | "nshift_price_drift"> {
    if (storedPrice === undefined || rebookedPrice === undefined) {
      return {}
    }

    const drift = priceDifference(rebookedPrice, storedPrice)
    if (drift === 0) {
      return {}
    }

    this.logger_.warn(
      `[nshift] Order ${orderId} was booked in a new nShift session at ` +
        `${rebookedPrice}, but its shipping method was priced at ${storedPrice} ` +
        `(drift ${drift}). The booking went ahead; check the shipping charge.`
    )
    return { nshift_rebooked_price: rebookedPrice, nshift_price_drift: drift }
  }

  /**
   * Creates a session to book a shipment whose checkout session is missing or no
   * longer accepted by nShift, and checks the customer's selection is still offered
   * in it. Also returns what nShift now charges for the option and selected addons,
   * computed like the checkout price, so a drift from the stored price is visible.
   */
  private async createBookingSession(
    receiver: NShiftReceiver,
    totals: PackageTotals,
    currencyCode: string,
    method: NormalizedMethodData,
    split: boolean
  ): Promise<BookingSession> {
    const request: NShiftRequestContext = {
      cacheKey: "",
      payload: this.toContextPayload(currencyCode, receiver, totals),
      totals,
      receiver,
      packages: totals.packages,
      currencyCode,
    }

    const resolved = split
      ? await this.createSplitSessionWithOptions(request, method.preselected_store_id)
      : await this.createSessionWithOptions(request, method.preselected_store_id)

    const optionId = method.option_id ?? ""
    const option = this.findOption(resolved.response, optionId)
    const unavailable = (what: string) =>
      new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `The nShift session for this shipping method is missing or no longer valid, and ` +
          `${what} for ${receiver.country} ${receiver.postalCode}. Create the ` +
          `fulfillment with another shipping option, or book the shipment in nShift.`
      )

    if (!option) {
      throw unavailable(`nShift no longer offers delivery option ${optionId}`)
    }
    if (
      method.pickup_point_id &&
      !(option.pickupPoints ?? []).some(
        (point) => point.pickupPointId === method.pickup_point_id
      )
    ) {
      throw unavailable(
        `pickup point ${method.pickup_point_id} is no longer offered for delivery ` +
          `option ${optionId}`
      )
    }
    if (
      method.time_slot_id &&
      !(option.timeSlots ?? []).some((slot) => slot.timeSlotId === method.time_slot_id)
    ) {
      throw unavailable(
        `time slot ${method.time_slot_id} is no longer offered for delivery option ` +
          `${optionId}`
      )
    }

    const basePrice = toNumber(option.price)

    return {
      session: {
        sessionId: resolved.sessionId,
        ...(resolved.subShipmentId ? { subShipmentId: resolved.subShipmentId } : {}),
      },
      ...(basePrice === undefined
        ? {}
        : { price: basePrice + sumAddonPrices(option, method.addons) }),
    }
  }

  /**
   * Builds the nShift package for the items being fulfilled. Only the fulfilled
   * quantities are sent, which matters for partial fulfillments.
   */
  private buildFulfillmentTotals(
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined
  ): PackageTotals {
    const orderItems = order?.items ?? []

    const shippableItems: ShippableItem[] = items.map((item) => {
      const orderItem = orderItems.find(
        (candidate) => candidate.id === item.line_item_id
      )

      return {
        quantity: item.quantity,
        variant_sku: item.sku ?? orderItem?.variant_sku,
        variant_id: orderItem?.variant_id,
        requires_shipping: true,
        variant: readVariant(orderItem),
      }
    })

    // A shipment carries no goods value, so never send `totalPrice` here.
    return buildPackages(shippableItems, {
      ...this.options_,
      send_cart_total: false,
    })
  }

  /** Deletes the nShift partial shipment behind a cancelled fulfillment. */
  async cancelFulfillment(data: Record<string, unknown>): Promise<void> {
    const shipmentId = toTrimmedString(data?.nshift_shipment_id)

    if (!shipmentId) {
      return
    }

    try {
      await this.client.deletePartialShipment(shipmentId)
    } catch (error) {
      // The shipment may already have been booked in the Book & Print platform, in
      // which case nShift Checkout can no longer delete it. Cancelling the Medusa
      // fulfillment should still succeed.
      const reason =
        error instanceof NShiftApiError || error instanceof Error
          ? error.message
          : String(error)
      this.logger_.warn(
        `[nshift] Could not delete partial shipment ${shipmentId}: ${reason}`
      )
    }
  }

  /**
   * Shipping options are only usable if they carry the nShift delivery option that
   * `getFulfillmentOptions` returned.
   */
  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return !!(toTrimmedString(data?.option_id) ?? toTrimmedString(data?.id))
  }
}

export default NShiftProviderService
