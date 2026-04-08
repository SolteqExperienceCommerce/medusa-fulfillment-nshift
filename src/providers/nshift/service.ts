import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import { MedusaError } from "@medusajs/framework/utils"
import {
  FulfillmentOption,
  CalculateShippingOptionPriceDTO,
  CalculatedShippingOptionPrice,
  CreateShippingOptionDTO,
} from "@medusajs/framework/types"
import { NShiftClient } from "./client"
import {
  NShiftOptions,
  NShiftDeliveryOption,
  NShiftReceiver,
  NShiftPackage,
  FetchDeliveryOptionsResponse,
} from "./types"

class NShiftProviderService extends AbstractFulfillmentProviderService {
  static identifier = "nshift"
  protected options_: NShiftOptions
  protected client: NShiftClient

  constructor({}, options: NShiftOptions) {
    super()
    this.options_ = options
    this.client = new NShiftClient(options)
  }

  // ── Helper: build nShift receiver from Medusa address ──

  private buildReceiver(address?: Record<string, unknown>): NShiftReceiver {
    if (!address) {
      return {}
    }
    return {
      name: [address.first_name, address.last_name].filter(Boolean).join(" ") ||
        (address.name as string) || "",
      address1: (address.address_1 as string) || (address.address1 as string) || "",
      address2: (address.address_2 as string) || (address.address2 as string) || "",
      postalCode: (address.postal_code as string) || (address.postalCode as string) || "",
      city: (address.city as string) || "",
      state: (address.province as string) || (address.state as string) || "",
      country: (address.country_code as string) || (address.country as string) || "",
      email: (address.email as string) || "",
      phone: (address.phone as string) || "",
    }
  }

  // ── Helper: build nShift packages from Medusa cart/order items ──

  private buildPackages(items?: any[]): NShiftPackage[] {
    if (!items || items.length === 0) {
      return [{ weightKg: 0.5 }]
    }

    const totalWeightKg = items.reduce((sum, item) => {
      const weight = item.variant?.weight || 0
      return sum + weight * (item.quantity || 1)
    }, 0)

    return [
      {
        weightKg: totalWeightKg || 0.5,
        articles: items.map((item) => ({
          articleNo: item.variant_sku || item.sku || "",
          quantity: item.quantity || 1,
          weightKg: item.variant?.weight || null,
        })),
      },
    ]
  }

  // ── Helper: create session and fetch delivery options ──

  private async fetchOptions(context: {
    currency_code?: string
    shipping_address?: Record<string, unknown>
    items?: any[]
  }): Promise<FetchDeliveryOptionsResponse> {
    const currencyCode = (context.currency_code || "EUR").toUpperCase()
    const languageCode = this.options_.language_code || "en"
    const localeId = this.options_.locale_id || "en-GB"

    const receiver = this.buildReceiver(context.shipping_address)
    const packages = this.buildPackages(context.items)

    // Step 1: Create a session
    const session = await this.client.createSession({
      currencyCode,
      languageCode,
      localeId,
      receiver,
      packages,
      includeInConversionRate: true,
    })

    // Step 2: Fetch delivery options for the session
    const deliveryOptions = await this.client.fetchDeliveryOptions(
      session.sessionId,
      {
        currencyCode,
        languageCode,
        localeId,
        receiver,
        packages,
      }
    )

    return deliveryOptions
  }

  // ═══════════════════════════════════════════════════════════════════
  // AbstractFulfillmentProviderService methods
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Returns the fulfillment options that nShift provides.
   * Each option represents a delivery option retrieved from nShift Checkout.
   * These appear in the admin when creating shipping options.
   */
  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    // nShift requires receiver context (at least country) to return delivery options.
    // We use default_country / default_postal_code from the module config.
    const defaultCountry = this.options_.default_country
    const defaultPostalCode = this.options_.default_postal_code

    if (!defaultCountry) {
      console.warn(
        "[nShift] default_country is not set in module options. " +
        "getFulfillmentOptions needs a country to retrieve delivery options. " +
        "Set NSHIFT_DEFAULT_COUNTRY in .env (e.g. \"FI\")."
      )
    }

    const languageCode = this.options_.language_code || "en"
    const localeId = this.options_.locale_id || "en-GB"

    const receiver: NShiftReceiver = {
      country: defaultCountry || "",
      postalCode: defaultPostalCode || "",
    }

    try {
      const session = await this.client.createSession({
        currencyCode: "EUR",
        languageCode,
        localeId,
        receiver,
      })

      const deliveryOptions = await this.client.fetchDeliveryOptions(
        session.sessionId,
        {
          currencyCode: "EUR",
          languageCode,
          localeId,
          receiver,
        }
      )

      const options = deliveryOptions.options
        .filter((option) => option.valid !== false)
        .map((option) => ({
          id: option.optionId,
          name: option.name || option.title || option.carrierProductName || "Unknown",
          carrier_id: option.carrierId || "",
          carrier_product_id: option.carrierProductId || "",
          carrier_name: option.carrierName || "",
          option_id: option.optionId,
        }))

      if (options.length === 0) {
        console.warn(
          "[nShift] No valid delivery options returned. " +
          "Check your nShift Checkout configuration/connection and ensure " +
          `delivery options are configured for country "${defaultCountry}".`
        )
      }

      return options
    } catch (error) {
      console.error(
        "[nShift] Failed to fetch fulfillment options:",
        error instanceof Error ? error.message : error
      )
      return []
    }
  }

  /**
   * All nShift delivery options support calculated pricing since
   * prices come from the nShift Checkout API based on receiver details.
   */
  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return true
  }

  /**
   * Calculates the shipping price for a given delivery option.
   * Creates a session, fetches delivery options with the checkout context,
   * and returns the price for the matched option.
   */
  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    try {
      const { option_id } = optionData as {
        option_id?: string
      }
      const { session_id: existingSessionId } = (data || {}) as {
        session_id?: string
      }

      const currencyCode = ((context.currency_code as string) || "EUR").toUpperCase()
      const languageCode = this.options_.language_code || "en"
      const localeId = this.options_.locale_id || "en-GB"

      const receiver = this.buildReceiver(
        context.shipping_address as unknown as Record<string, unknown> | undefined
      )
      const packages = this.buildPackages(context.items as any[])

      let sessionId = existingSessionId

      if (!sessionId) {
        const session = await this.client.createSession({
          currencyCode,
          languageCode,
          localeId,
          receiver,
          packages,
          includeInConversionRate: true,
        })
        sessionId = session.sessionId
      }

      const deliveryOptions = await this.client.fetchDeliveryOptions(
        sessionId,
        {
          currencyCode,
          languageCode,
          localeId,
          receiver,
          packages,
        }
      )

      // Find the matching option
      let matchedOption: NShiftDeliveryOption | undefined
      if (option_id) {
        matchedOption = deliveryOptions.options.find(
          (opt) => opt.optionId === option_id
        )
      }

      // Fallback to first valid option if no match
      if (!matchedOption) {
        matchedOption = deliveryOptions.options.find((opt) => opt.valid !== false)
      }

      const price = matchedOption?.price ?? 0

      return {
        calculated_amount: price,
        is_calculated_price_tax_inclusive: !!matchedOption?.taxRate,
      }
    } catch (error) {
      // Return 0 if we can't calculate price, let the platform handle it
      return {
        calculated_amount: 0,
        is_calculated_price_tax_inclusive: false,
      }
    }
  }

  /**
   * Validates fulfillment data when a customer selects a shipping option.
   * Creates a session in nShift and stores the session ID + option ID
   * in the shipping method's data for later use.
   */
  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<any> {
    let { session_id } = data as { session_id?: string }

    if (!session_id) {
      const currencyCode = ((context.currency_code as string) || "EUR").toUpperCase()
      const languageCode = this.options_.language_code || "en"
      const localeId = this.options_.locale_id || "en-GB"

      // @ts-ignore
      const receiver = this.buildReceiver(context.shipping_address)
      // @ts-ignore
      const packages = this.buildPackages(context.items)

      const session = await this.client.createSession({
        currencyCode,
        languageCode,
        localeId,
        receiver,
        packages,
        includeInConversionRate: true,
      })
      session_id = session.sessionId
    }

    return {
      ...data,
      session_id,
      option_id: (optionData as any).option_id,
      carrier_id: (optionData as any).carrier_id,
      carrier_product_id: (optionData as any).carrier_product_id,
      pickup_point_id: (data as any).pickup_point_id || undefined,
      time_slot_id: (data as any).time_slot_id || undefined,
    }
  }

  /**
   * Creates a fulfillment by creating a partial shipment in nShift.
   * This is called when an admin creates a fulfillment for an order.
   */
  async createFulfillment(
    data: object,
    items: object[],
    order: object | undefined,
    fulfillment: Record<string, unknown>
  ): Promise<any> {
    const {
      session_id,
      option_id,
      pickup_point_id,
      time_slot_id,
    } = data as {
      session_id: string
      option_id: string
      pickup_point_id?: string
      time_slot_id?: string
    }

    if (!session_id || !option_id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "nShift session_id and option_id are required to create a fulfillment. " +
        "Ensure the shipping method was properly created during checkout."
      )
    }

    // Build items for the nShift package
    const orderItems = items.map((item: any) => {
      // @ts-ignore
      const orderItem = order?.items?.find((i: any) => i.id === item.line_item_id)
      return {
        articleNo: orderItem?.variant_sku || "",
        quantity: item.quantity || 1,
        weightKg: orderItem?.variant?.weight || null,
      }
    })

    // Build receiver from order shipping address
    // @ts-ignore
    const shippingAddress = order?.shipping_address
    const receiver: NShiftReceiver = this.buildReceiver(shippingAddress)

    // @ts-ignore
    const orderId = order?.id || order?.display_id?.toString() || ""

    const partialShipment = await this.client.createPartialShipment(
      {
        orderId,
        sessionId: session_id,
        optionId: option_id,
        pickupPointId: pickup_point_id,
        timeSlotId: time_slot_id,
        receiver,
        packages: [
          {
            articles: orderItems,
            weightKg: orderItems.reduce(
              (sum: number, item: any) => sum + ((item.weightKg || 0) * (item.quantity || 1)),
              0
            ) || 0.5,
          },
        ],
      },
      this.options_.send_to_book_and_print
    )

    return {
      data: {
        ...(fulfillment.data as object || {}),
        nshift_shipment_id: partialShipment.id,
        nshift_order_id: partialShipment.orderId,
        nshift_carrier: partialShipment.carrier,
        nshift_carrier_product: partialShipment.carrierProduct,
      },
    }
  }

  /**
   * Cancels a fulfillment by deleting the associated partial shipment in nShift.
   */
  async cancelFulfillment(data: Record<string, unknown>): Promise<any> {
    const { nshift_shipment_id } = data as {
      nshift_shipment_id?: string
    }

    if (nshift_shipment_id) {
      try {
        await this.client.deletePartialShipment(nshift_shipment_id)
      } catch (error) {
        // Log but don't throw — the shipment may already be processed
        // in the Book & Print platform and can't be deleted here
        console.warn(
          `Failed to delete nShift partial shipment ${nshift_shipment_id}:`,
          error
        )
      }
    }
  }

  /**
   * Validates a shipping option. nShift options are always valid since
   * they come from the nShift API.
   */
  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return true
  }
}

export default NShiftProviderService
