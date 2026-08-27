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
  buildPackages,
  buildReceiver,
  describeMissingReceiverFields,
  isReceiverDeliverable,
  normalizeMethodData,
  readVariant,
  ShippableItem,
  sumAddonPrices,
  toFulfillmentOptionData,
  toNumber,
  toTrimmedString,
} from "./mappers"
import { TtlCache } from "./session-cache"
import {
  CreatePartialShipmentRequest,
  FetchDeliveryOptionsResponse,
  NShiftContextPayload,
  NShiftDeliveryOption,
  NShiftFulfillmentData,
  NShiftMethodData,
  NShiftOptions,
  NShiftPackage,
  NShiftPickupPoint,
  NShiftReceiver,
  NShiftTimeSlot,
} from "./types"

type InjectedDependencies = {
  logger: Logger
}

/** A session plus the delivery options that were fetched inside it. */
type ResolvedDeliveryOptions = {
  sessionId: string
  response: FetchDeliveryOptionsResponse
}

/** Everything needed to talk to nShift for one checkout context. */
type NShiftRequestContext = {
  cacheKey: string
  payload: NShiftContextPayload
  receiver: NShiftReceiver
  packages: NShiftPackage[]
  currencyCode: string
}

const DEFAULT_LANGUAGE_CODE = "en"
const DEFAULT_LOCALE_ID = "en-GB"
const DEFAULT_CURRENCY = "EUR"
const DEFAULT_OPTIONS_CACHE_TTL_MS = 30_000

class NShiftProviderService extends AbstractFulfillmentProviderService {
  static identifier = "nshift"

  protected readonly options_: NShiftOptions
  protected readonly logger_: Logger
  protected readonly client: NShiftClient

  private readonly deliveryOptionsCache: TtlCache<ResolvedDeliveryOptions>

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
    const { packages, totalWeightKg, totalVolumeCm3, totalPrice } = buildPackages(
      context.items,
      this.options_
    )

    const payload: NShiftContextPayload = {
      currencyCode,
      languageCode: this.languageCode,
      localeId: this.localeId,
      receiver,
      ...(packages.length ? { packages } : {}),
      ...(totalWeightKg === undefined ? {} : { totalWeightKg }),
      ...(totalVolumeCm3 === undefined ? {} : { totalVolumeCm3 }),
      ...(totalPrice === undefined ? {} : { totalPrice }),
    }

    // The cart id keeps sessions from being shared between carts even if two carts
    // happen to produce an identical payload.
    const scope = toTrimmedString(context.id) ?? "no-cart"
    const cacheKey = `${scope}:${createHash("sha1")
      .update(JSON.stringify(payload))
      .digest("hex")}`

    return { cacheKey, payload, receiver, packages, currencyCode }
  }

  /**
   * Creates a session and fetches its delivery options, reusing both for every
   * option of the same checkout context (see {@link TtlCache}).
   */
  private async resolveDeliveryOptions(
    request: NShiftRequestContext
  ): Promise<ResolvedDeliveryOptions> {
    return this.deliveryOptionsCache.resolve(request.cacheKey, async () => {
      const session = await this.client.createSession({
        ...request.payload,
        includeInConversionRate: this.options_.include_in_conversion_rate ?? true,
      })

      const response = await this.client.fetchDeliveryOptions(
        session.sessionId,
        request.payload
      )

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

      return { sessionId: response.sessionId || session.sessionId, response }
    })
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
  ): Promise<CalculatedShippingOptionPrice> {
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

  private async calculatePriceOrThrow(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
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

    const { response } = await this.resolveDeliveryOptions(request)
    const option = this.findOption(response, optionId)

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

    return {
      calculated_amount: basePrice + sumAddonPrices(option, method.addons),
      is_calculated_price_tax_inclusive: this.pricesTaxInclusive,
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

    const { sessionId, response } = await this.resolveDeliveryOptions(request)
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

    const validated: NShiftMethodData = {
      // Preserve anything the storefront sent so consumers relying on extra keys
      // (e.g. widget payload fragments) keep working.
      ...data,
      session_id: sessionId,
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

    if (!method.session_id || !method.option_id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "nShift session_id and option_id are required to create a fulfillment. " +
          "Ensure the shipping method was created through this provider during checkout."
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

    const request: CreatePartialShipmentRequest = {
      orderId: toTrimmedString(order?.id) ?? String(order?.display_id ?? ""),
      sessionId: method.session_id,
      optionId: method.option_id,
      receiver,
      packages: this.buildFulfillmentPackages(items, order),
      ...(method.pickup_point_id ? { pickupPointId: method.pickup_point_id } : {}),
      ...(method.time_slot_id ? { timeSlotId: method.time_slot_id } : {}),
      ...(method.addons.length ? { addons: method.addons } : {}),
      ...(method.fields.length ? { fields: method.fields } : {}),
    }

    const shipment = await this.client.createPartialShipment(
      request,
      this.options_.send_to_book_and_print
    )

    const fulfillmentData: NShiftFulfillmentData = {
      nshift_shipment_id: shipment.id,
      nshift_order_id: shipment.orderId,
      nshift_carrier: shipment.carrier,
      nshift_carrier_product: shipment.carrierProduct,
    }

    return {
      data: { ...(data ?? {}), ...fulfillmentData },
      labels: [],
    }
  }

  /**
   * Builds the nShift package for the items being fulfilled. Only the fulfilled
   * quantities are sent, which matters for partial fulfillments.
   */
  private buildFulfillmentPackages(
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined
  ): NShiftPackage[] {
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
    const { packages } = buildPackages(shippableItems, {
      ...this.options_,
      send_cart_total: false,
    })

    return packages
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
