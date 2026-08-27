import {
  CalculateShippingOptionPriceDTO,
  FulfillmentOrderDTO,
  Logger,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import { NShiftApiError } from "../client"
import NShiftProviderService from "../service"
import { FetchDeliveryOptionsResponse, NShiftDeliveryOption, NShiftOptions } from "../types"

type ClientStub = {
  createSession: jest.Mock
  fetchDeliveryOptions: jest.Mock
  createPartialShipment: jest.Mock
  deletePartialShipment: jest.Mock
}

const logger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
  silly: jest.fn(),
  verbose: jest.fn(),
  http: jest.fn(),
  panic: jest.fn(),
  shouldLog: jest.fn(),
  setLogLevel: jest.fn(),
  unsetLogLevel: jest.fn(),
  activity: jest.fn(),
  progress: jest.fn(),
  failure: jest.fn(),
  success: jest.fn(),
}

const baseOptions: NShiftOptions = {
  client_id: "cid",
  client_secret: "secret",
  connection_id: "conn",
  default_country: "FI",
  default_postal_code: "00100",
}

const postiOption: NShiftDeliveryOption = {
  valid: true,
  optionId: "posti",
  name: "Posti home FI",
  carrierId: "948",
  carrierProductId: "10543",
  price: 19,
  taxRate: 25.5,
  addons: [{ addonId: "dangerous-goods", price: 79 }],
}

const schenkerOption: NShiftDeliveryOption = {
  valid: true,
  optionId: "schenker",
  name: "Schenker PL",
  price: 49,
}

const optionsResponse = (
  options: NShiftDeliveryOption[]
): FetchDeliveryOptionsResponse => ({
  sessionId: "session-1",
  options,
})

const finnishAddress = {
  id: "caaddr_1",
  first_name: "Test",
  last_name: "Person",
  address_1: "Mannerheimintie 1",
  city: "Helsinki",
  postal_code: "00100",
  country_code: "fi",
  created_at: new Date(),
  updated_at: new Date(),
}

/**
 * Medusa's calculation context is a deeply-typed cart projection. The provider only
 * reads `id`, `currency_code`, `shipping_address` and `items`, so the fixtures build
 * the shape the provider actually consumes and hand it over as the DTO the abstract
 * signature declares.
 */
type PriceContext = CalculateShippingOptionPriceDTO["context"]

const cartContext = (overrides: Record<string, unknown> = {}): PriceContext => {
  const context = {
    id: "cart_1",
    currency_code: "eur",
    shipping_address: finnishAddress,
    items: [
      {
        id: "item_1",
        quantity: 1,
        unit_price: 10,
        total: 10,
        variant_sku: "SWEATSHIRT-XL",
        requires_shipping: true,
        variant: { weight: 0.5 },
      },
    ],
    ...overrides,
  }

  return context as unknown as PriceContext
}

const validationContext = (overrides: Record<string, unknown> = {}) =>
  cartContext(overrides) as unknown as ValidateFulfillmentDataContext

/** Builds a provider whose HTTP client is replaced by a stub. */
const buildProvider = (
  options: Partial<NShiftOptions> = {},
  clientOverrides: Partial<ClientStub> = {}
) => {
  const client: ClientStub = {
    createSession: jest.fn().mockResolvedValue({ sessionId: "session-1" }),
    fetchDeliveryOptions: jest
      .fn()
      .mockResolvedValue(optionsResponse([postiOption, schenkerOption])),
    createPartialShipment: jest.fn().mockResolvedValue({
      id: "shipment-1",
      orderId: "order_1",
      carrier: "948",
      carrierProduct: "10543",
    }),
    deletePartialShipment: jest.fn().mockResolvedValue(undefined),
    ...clientOverrides,
  }

  const provider = new NShiftProviderService({ logger }, {
    ...baseOptions,
    ...options,
  })

  // The provider owns its client; swapping it keeps the tests offline.
  Reflect.set(provider, "client", client)

  return { provider, client }
}

beforeEach(() => jest.clearAllMocks())

describe("constructor", () => {
  it("fails fast when credentials are missing", () => {
    expect(
      () =>
        new NShiftProviderService({ logger }, {
          client_id: "",
          client_secret: "secret",
          connection_id: "conn",
        })
    ).toThrow(/missing required options: client_id/)
  })
})

describe("calculatePrice", () => {
  it("returns the price of the requested option", async () => {
    const { provider } = buildProvider()

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      {},
      cartContext()
    )

    expect(price).toEqual({
      calculated_amount: 19,
      is_calculated_price_tax_inclusive: true,
    })
  })

  it("adds the price of selected addons", async () => {
    const { provider } = buildProvider()

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      { addon_ids: ["dangerous-goods"] },
      cartContext()
    )

    expect(price.calculated_amount).toBe(98)
  })

  it("honours prices_tax_inclusive instead of guessing from taxRate", async () => {
    const { provider } = buildProvider({ prices_tax_inclusive: false })

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      {},
      cartContext()
    )

    expect(price.is_calculated_price_tax_inclusive).toBe(false)
  })

  it("reports no price instead of another carrier's price when the option is gone", async () => {
    const { provider } = buildProvider(
      {},
      {
        fetchDeliveryOptions: jest
          .fn()
          .mockResolvedValue(optionsResponse([schenkerOption])),
      }
    )

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      {},
      cartContext()
    )

    expect(price.calculated_amount).toBeUndefined()
    expect("calculated_amount" in price).toBe(false)
  })

  it("reports no price when nShift returns the option without a price", async () => {
    const { provider } = buildProvider(
      {},
      {
        fetchDeliveryOptions: jest
          .fn()
          .mockResolvedValue(optionsResponse([{ ...postiOption, price: null }])),
      }
    )

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      {},
      cartContext()
    )

    expect("calculated_amount" in price).toBe(false)
  })

  it("reports no price when nShift is unreachable, rather than failing the cart", async () => {
    const { provider } = buildProvider(
      {},
      {
        createSession: jest
          .fn()
          .mockRejectedValue(new NShiftApiError("nShift API error (503)", 503)),
      }
    )

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      {},
      cartContext()
    )

    expect("calculated_amount" in price).toBe(false)
    expect(logger.error).toHaveBeenCalled()
  })

  it("reports no price when the shipping option has no nShift option attached", async () => {
    const { provider, client } = buildProvider()

    const price = await provider.calculatePrice({}, {}, cartContext())

    expect("calculated_amount" in price).toBe(false)
    expect(client.createSession).not.toHaveBeenCalled()
  })

  it("does not call nShift when the address has no postal code", async () => {
    const { provider, client } = buildProvider()

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      {},
      cartContext({ shipping_address: { ...finnishAddress, postal_code: null } })
    )

    expect("calculated_amount" in price).toBe(false)
    expect(client.createSession).not.toHaveBeenCalled()
  })

  it("reuses one session and one options fetch across options of the same cart", async () => {
    const { provider, client } = buildProvider()
    const context = cartContext()

    await Promise.all([
      provider.calculatePrice({ option_id: "posti" }, {}, context),
      provider.calculatePrice({ option_id: "schenker" }, {}, context),
      provider.calculatePrice({ option_id: "posti" }, {}, context),
    ])

    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(client.fetchDeliveryOptions).toHaveBeenCalledTimes(1)
  })

  it("sends a compacted receiver and the cart totals to nShift", async () => {
    const { provider, client } = buildProvider()

    await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())

    const payload = client.createSession.mock.calls[0][0]
    expect(payload.receiver).toEqual({
      name: "Test Person",
      address1: "Mannerheimintie 1",
      city: "Helsinki",
      postalCode: "00100",
      country: "FI",
    })
    expect(payload.currencyCode).toBe("EUR")
    expect(payload.totalPrice).toBe(10)
    expect(payload.totalWeightKg).toBe(0.5)
  })
})

describe("validateFulfillmentData", () => {
  it("pins the session that produced the price and enriches the method data", async () => {
    const { provider, client } = buildProvider()

    const data = await provider.validateFulfillmentData(
      { option_id: "posti", name: "Posti home FI" },
      {},
      validationContext()
    )

    expect(data).toMatchObject({
      session_id: "session-1",
      option_id: "posti",
      carrier_id: "948",
      carrier_product_id: "10543",
      currency_code: "EUR",
      price: 19,
    })
    expect(client.createSession).toHaveBeenCalledTimes(1)
  })

  it("reuses the session created while pricing the same cart", async () => {
    const { provider, client } = buildProvider()
    const context = cartContext()

    await provider.calculatePrice({ option_id: "posti" }, {}, context)
    await provider.validateFulfillmentData(
      { option_id: "posti" },
      {},
      context as unknown as ValidateFulfillmentDataContext
    )

    expect(client.createSession).toHaveBeenCalledTimes(1)
  })

  it("keeps extra keys the storefront sent", async () => {
    const { provider } = buildProvider()

    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      { widget_payload: { foo: "bar" } },
      validationContext()
    )

    expect(data.widget_payload).toEqual({ foo: "bar" })
    expect(data.session_id).toBe("session-1")
  })

  it("rejects a selection nShift no longer offers", async () => {
    const { provider } = buildProvider(
      {},
      {
        fetchDeliveryOptions: jest
          .fn()
          .mockResolvedValue(optionsResponse([schenkerOption])),
      }
    )

    await expect(
      provider.validateFulfillmentData(
        { option_id: "posti" },
        {},
        validationContext()
      )
    ).rejects.toThrow(/no longer offers delivery option posti/)
  })

  it("rejects an incomplete shipping address", async () => {
    const { provider } = buildProvider()

    await expect(
      provider.validateFulfillmentData(
        { option_id: "posti" },
        {},
        validationContext({ shipping_address: { ...finnishAddress, postal_code: null } })
      )
    ).rejects.toThrow(/postal code/)
  })

  it("validates the selected pickup point", async () => {
    const withPickup = {
      ...postiOption,
      pickupPoints: [{ pickupPointId: "K384", name: "R-kioski" }],
    }
    const { provider } = buildProvider(
      {},
      { fetchDeliveryOptions: jest.fn().mockResolvedValue(optionsResponse([withPickup])) }
    )

    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      { pickup_point_id: "K384" },
      validationContext()
    )
    expect(data.pickup_point_id).toBe("K384")

    await expect(
      provider.validateFulfillmentData(
        { option_id: "posti" },
        { pickup_point_id: "NOPE" },
        validationContext()
      )
    ).rejects.toThrow(/Pickup point NOPE is not available/)
  })

  it("requires a pickup point when the option has no default", async () => {
    const withPickup = {
      ...postiOption,
      noDefaultPickupPoint: true,
      pickupPoints: [{ pickupPointId: "K384" }],
    }
    const { provider } = buildProvider(
      {},
      { fetchDeliveryOptions: jest.fn().mockResolvedValue(optionsResponse([withPickup])) }
    )

    await expect(
      provider.validateFulfillmentData(
        { option_id: "posti" },
        {},
        validationContext()
      )
    ).rejects.toThrow(/requires a pickup point/)
  })

  it("rejects an unknown addon", async () => {
    const { provider } = buildProvider()

    await expect(
      provider.validateFulfillmentData(
        { option_id: "posti" },
        { addon_ids: ["nope"] },
        validationContext()
      )
    ).rejects.toThrow(/Addon\(s\) nope are not available/)
  })
})

describe("getFulfillmentOptions", () => {
  it("maps nShift delivery options for the admin", async () => {
    const { provider } = buildProvider()

    await expect(provider.getFulfillmentOptions()).resolves.toEqual([
      {
        id: "posti",
        option_id: "posti",
        name: "Posti home FI",
        carrier_id: "948",
        carrier_product_id: "10543",
      },
      { id: "schenker", option_id: "schenker", name: "Schenker PL" },
    ])
  })

  it("explains the misconfiguration instead of returning an empty list", async () => {
    const { provider } = buildProvider({
      default_country: undefined,
      default_postal_code: undefined,
    })

    await expect(provider.getFulfillmentOptions()).rejects.toThrow(
      /Set default_country and default_postal_code/
    )
  })

  it("surfaces an nShift failure with its reason", async () => {
    const { provider } = buildProvider(
      {},
      {
        fetchDeliveryOptions: jest
          .fn()
          .mockRejectedValue(
            new NShiftApiError("nShift API error (422): Invalid input data", 422, [
              { issueCode: "MISSING_POSTAL_CODE", severity: "ERROR" },
            ])
          ),
      }
    )

    await expect(provider.getFulfillmentOptions()).rejects.toThrow(
      /MISSING_POSTAL_CODE|Invalid input data/
    )
  })
})

describe("createFulfillment", () => {
  const buildOrder = (
    overrides: Record<string, unknown> = {}
  ): Partial<FulfillmentOrderDTO> =>
    ({
      id: "order_1",
      display_id: 17,
      shipping_address: finnishAddress,
      items: [{ id: "ordli_1", variant_sku: "SWEATSHIRT-XL", variant_id: "variant_1" }],
      ...overrides,
    }) as unknown as Partial<FulfillmentOrderDTO>

  it("forwards pickup point, time slot, addons and fields to nShift", async () => {
    const { provider, client } = buildProvider()

    const result = await provider.createFulfillment(
      {
        session_id: "session-1",
        option_id: "posti",
        pickup_point_id: "K384",
        time_slot_id: "slot-1",
        addons: [{ addon_id: "dangerous-goods" }],
        fields: [{ field_id: "DOORCODE", value: "1234" }],
      },
      [{ line_item_id: "ordli_1", quantity: 1, sku: "SWEATSHIRT-XL" }],
      buildOrder(),
      {}
    )

    expect(client.createPartialShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_1",
        sessionId: "session-1",
        optionId: "posti",
        pickupPointId: "K384",
        timeSlotId: "slot-1",
        addons: [{ addonId: "dangerous-goods" }],
        fields: [{ fieldId: "DOORCODE", value: "1234" }],
        receiver: expect.objectContaining({ country: "FI", postalCode: "00100" }),
      }),
      undefined
    )

    expect(result.data).toMatchObject({
      nshift_shipment_id: "shipment-1",
      nshift_carrier: "948",
      nshift_carrier_product: "10543",
    })
  })

  it("requires the session data written at checkout", async () => {
    const { provider } = buildProvider()

    await expect(
      provider.createFulfillment({ option_id: "posti" }, [], buildOrder(), {})
    ).rejects.toThrow(/session_id and option_id are required/)
  })

  it("rejects an order whose address nShift cannot ship to", async () => {
    const { provider } = buildProvider()

    await expect(
      provider.createFulfillment(
        { session_id: "session-1", option_id: "posti" },
        [],
        buildOrder({ shipping_address: { ...finnishAddress, postal_code: null } }),
        {}
      )
    ).rejects.toThrow(/missing a postal code/)
  })
})

describe("cancelFulfillment", () => {
  it("deletes the partial shipment", async () => {
    const { provider, client } = buildProvider()

    await provider.cancelFulfillment({ nshift_shipment_id: "shipment-1" })

    expect(client.deletePartialShipment).toHaveBeenCalledWith("shipment-1")
  })

  it("still succeeds when nShift can no longer delete the shipment", async () => {
    const { provider } = buildProvider(
      {},
      {
        deletePartialShipment: jest
          .fn()
          .mockRejectedValue(new NShiftApiError("already booked", 409)),
      }
    )

    await expect(
      provider.cancelFulfillment({ nshift_shipment_id: "shipment-1" })
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })

  it("does nothing without a shipment id", async () => {
    const { provider, client } = buildProvider()

    await provider.cancelFulfillment({})

    expect(client.deletePartialShipment).not.toHaveBeenCalled()
  })
})

describe("validateOption", () => {
  it("only accepts options carrying an nShift delivery option", async () => {
    const { provider } = buildProvider()

    await expect(provider.validateOption({ option_id: "posti" })).resolves.toBe(true)
    await expect(provider.validateOption({ id: "posti" })).resolves.toBe(true)
    await expect(provider.validateOption({})).resolves.toBe(false)
  })
})
