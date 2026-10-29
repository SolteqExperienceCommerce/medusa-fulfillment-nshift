import {
  CalculateShippingOptionPriceDTO,
  FulfillmentOrderDTO,
  Logger,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import { NShiftApiError } from "../client"
import NShiftProviderService from "../service"
import { BoundedMap } from "../session-cache"
import { FetchDeliveryOptionsResponse, NShiftDeliveryOption, NShiftOptions } from "../types"

type ClientStub = {
  createSession: jest.Mock
  updateSession: jest.Mock
  fetchDeliveryOptions: jest.Mock
  createPartialShipment: jest.Mock
  deletePartialShipment: jest.Mock
  createSplitSession: jest.Mock
  updateSplitSession: jest.Mock
  fetchSplitDeliveryOptions: jest.Mock
  createSplitPartialShipments: jest.Mock
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
    updateSession: jest.fn().mockImplementation(async (sessionId: string) => ({ sessionId })),
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
    createSplitSession: jest.fn().mockResolvedValue({
      sessionId: "split-1",
      subShipments: [{ subShipmentId: "split-1" }],
    }),
    updateSplitSession: jest
      .fn()
      .mockImplementation(async (sessionId: string) => ({ sessionId, subShipments: [] })),
    fetchSplitDeliveryOptions: jest.fn().mockResolvedValue({
      sessionId: "split-1",
      subShipments: [
        { subShipmentId: "split-1", options: [postiOption, schenkerOption] },
      ],
    }),
    createSplitPartialShipments: jest.fn().mockResolvedValue({
      shipments: [
        { id: "shipment-s1", orderId: "order_1", carrier: "948", carrierProduct: "10543" },
      ],
    }),
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
      nshift: expect.objectContaining({
        session_id: "session-1",
        option_id: "posti",
        price: 19,
        addons_price: 0,
      }),
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

  it("returns the method data plus exactly the nShift booking keys", async () => {
    const { provider } = buildProvider()
    const methodData = {
      session_id: "session-1",
      option_id: "posti",
      price: 19,
      currency_code: "EUR",
      custom: "kept",
    }

    const result = await provider.createFulfillment(
      methodData,
      [{ line_item_id: "ordli_1", quantity: 1, sku: "SWEATSHIRT-XL" }],
      buildOrder(),
      {}
    )

    // Medusa stores `data` on the fulfillment as-is, so its shape is a contract.
    expect(result).toEqual({
      data: {
        ...methodData,
        nshift_shipment_id: "shipment-1",
        nshift_session_id: "session-1",
        nshift_order_id: "order_1",
        nshift_carrier: "948",
        nshift_carrier_product: "10543",
      },
      labels: [],
    })
  })

  it("requires the delivery option written at checkout", async () => {
    const { provider, client } = buildProvider()

    await expect(
      provider.createFulfillment({ session_id: "session-1" }, [], buildOrder(), {})
    ).rejects.toThrow(/option_id is required/)
    expect(client.createSession).not.toHaveBeenCalled()
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

describe("split shipments", () => {
  const split = { split_shipments: true }

  it("prices an option from a one-sub-shipment split session", async () => {
    const { provider, client } = buildProvider(split)

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())

    expect(price.calculated_amount).toBe(19)
    expect(client.createSession).not.toHaveBeenCalled()
    expect(client.createSplitSession).toHaveBeenCalledWith(
      expect.objectContaining({
        currencyCode: "EUR",
        receiver: expect.objectContaining({ country: "FI", postalCode: "00100" }),
        subShipments: [
          expect.objectContaining({ totalWeightKg: 0.5, totalPrice: 10 }),
        ],
        includeInConversionRate: true,
      })
    )
    expect(client.fetchSplitDeliveryOptions).toHaveBeenCalledWith(
      "split-1",
      expect.objectContaining({
        subShipments: [expect.objectContaining({ subShipmentId: "split-1" })],
      })
    )
  })

  it("reuses one split session across options of the same profile's items", async () => {
    const { provider, client } = buildProvider(split)
    const context = cartContext()

    await Promise.all([
      provider.calculatePrice({ option_id: "posti" }, {}, context),
      provider.calculatePrice({ option_id: "schenker" }, {}, context),
    ])

    expect(client.createSplitSession).toHaveBeenCalledTimes(1)
    expect(client.fetchSplitDeliveryOptions).toHaveBeenCalledTimes(1)
  })

  it("uses only the endpoints of the configured mode", async () => {
    const single = buildProvider()
    const splitProvider = buildProvider(split)

    await single.provider.calculatePrice({ option_id: "posti" }, {}, cartContext())
    await splitProvider.provider.calculatePrice({ option_id: "posti" }, {}, cartContext())

    expect(single.client.createSplitSession).not.toHaveBeenCalled()
    expect(splitProvider.client.createSession).not.toHaveBeenCalled()
  })

  it("reports no price when the split fetch fails", async () => {
    const { provider } = buildProvider(split, {
      fetchSplitDeliveryOptions: jest
        .fn()
        .mockRejectedValue(new NShiftApiError("nShift API error (503)", 503)),
    })

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())

    expect("calculated_amount" in price).toBe(false)
  })

  it("persists the session and sub-shipment on the shipping method", async () => {
    const { provider } = buildProvider(split)

    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      {},
      validationContext()
    )

    expect(data).toMatchObject({
      session_id: "split-1",
      sub_shipment_id: "split-1",
      option_id: "posti",
      price: 19,
    })
  })

  it("books through the split endpoint and records the sub-shipment", async () => {
    const { provider, client } = buildProvider({ ...split, send_to_book_and_print: true })

    const result = await provider.createFulfillment(
      {
        session_id: "split-1",
        sub_shipment_id: "sub-2",
        option_id: "posti",
        pickup_point_id: "K384",
        addons: ["dangerous-goods"],
      },
      [{ line_item_id: "ordli_1", quantity: 1, sku: "SWEATSHIRT-XL" }],
      {
        id: "order_1",
        shipping_address: finnishAddress,
        items: [{ id: "ordli_1", variant_sku: "SWEATSHIRT-XL" }],
      } as unknown as Partial<FulfillmentOrderDTO>,
      {}
    )

    expect(client.createPartialShipment).not.toHaveBeenCalled()
    expect(client.createSplitPartialShipments).toHaveBeenCalledWith(
      {
        sessionId: "split-1",
        receiver: expect.objectContaining({ country: "FI" }),
        subShipments: [
          expect.objectContaining({
            subShipmentId: "sub-2",
            orderId: "order_1",
            optionId: "posti",
            pickupPointId: "K384",
            addons: [{ addonId: "dangerous-goods" }],
            packages: expect.any(Array),
          }),
        ],
      },
      true
    )
    expect(result.data).toMatchObject({
      session_id: "split-1",
      nshift_shipment_id: "shipment-s1",
      nshift_session_id: "split-1",
      nshift_sub_shipment_id: "sub-2",
    })
  })

  it("books a session without a sub-shipment through the single endpoint after split mode is turned on", async () => {
    const { provider, client } = buildProvider(split)

    const result = await provider.createFulfillment(
      { session_id: "session-1", option_id: "posti" },
      [],
      { id: "order_1", shipping_address: finnishAddress } as unknown as Partial<FulfillmentOrderDTO>,
      {}
    )

    expect(client.createSplitPartialShipments).not.toHaveBeenCalled()
    expect(client.createPartialShipment).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", optionId: "posti" }),
      undefined
    )
    expect(result.data).not.toHaveProperty("nshift_sub_shipment_id")
  })

  it("uses the split endpoint for a sub-shipment even when split mode is off", async () => {
    const { provider, client } = buildProvider()

    await provider.createFulfillment(
      { session_id: "split-1", sub_shipment_id: "sub-2", option_id: "posti" },
      [],
      { id: "order_1", shipping_address: finnishAddress } as unknown as Partial<FulfillmentOrderDTO>,
      {}
    )

    expect(client.createSplitPartialShipments).toHaveBeenCalled()
    expect(client.createPartialShipment).not.toHaveBeenCalled()
  })

  it("fails when nShift returns no shipment", async () => {
    const { provider } = buildProvider(split, {
      createSplitPartialShipments: jest.fn().mockResolvedValue({ shipments: [] }),
    })

    await expect(
      provider.createFulfillment(
        { session_id: "split-1", sub_shipment_id: "split-1", option_id: "posti" },
        [],
        { id: "order_1", shipping_address: finnishAddress } as unknown as Partial<FulfillmentOrderDTO>,
        {}
      )
    ).rejects.toThrow(/created no shipment/)
  })

  it("records the session but no sub-shipment for single shipments", async () => {
    const { provider } = buildProvider()

    const result = await provider.createFulfillment(
      { session_id: "session-1", option_id: "posti" },
      [],
      { id: "order_1", shipping_address: finnishAddress } as unknown as Partial<FulfillmentOrderDTO>,
      {}
    )

    expect(result.data).toMatchObject({ nshift_session_id: "session-1" })
    expect(result.data).not.toHaveProperty("nshift_sub_shipment_id")
  })
})

describe("storefront-pinned sessions", () => {
  it("fetches options inside a pinned single session", async () => {
    const { provider, client } = buildProvider(
      {},
      {
        fetchDeliveryOptions: jest.fn().mockResolvedValue({
          sessionId: "pinned-1",
          options: [postiOption],
        }),
      }
    )

    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      { session_id: "pinned-1" },
      validationContext()
    )

    expect(client.createSession).not.toHaveBeenCalled()
    expect(client.fetchDeliveryOptions).toHaveBeenCalledWith(
      "pinned-1",
      expect.objectContaining({ currencyCode: "EUR" })
    )
    expect(data.session_id).toBe("pinned-1")
  })

  it("fetches options inside a pinned split sub-shipment", async () => {
    const { provider, client } = buildProvider(
      { split_shipments: true },
      {
        fetchSplitDeliveryOptions: jest.fn().mockResolvedValue({
          sessionId: "pinned-1",
          subShipments: [
            { subShipmentId: "other", options: [] },
            { subShipmentId: "sub-2", options: [postiOption] },
          ],
        }),
      }
    )

    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      { sessionId: "pinned-1", subShipmentId: "sub-2" },
      validationContext()
    )

    expect(client.createSplitSession).not.toHaveBeenCalled()
    expect(client.fetchSplitDeliveryOptions).toHaveBeenCalledWith(
      "pinned-1",
      expect.objectContaining({
        subShipments: [
          expect.objectContaining({ subShipmentId: "sub-2", totalWeightKg: 0.5 }),
        ],
      })
    )
    expect(data).toMatchObject({ session_id: "pinned-1", sub_shipment_id: "sub-2" })
  })

  it("creates a new session when nShift no longer knows the pinned one", async () => {
    const fetchDeliveryOptions = jest
      .fn()
      .mockRejectedValueOnce(new NShiftApiError("nShift API error (404)", 404))
      .mockResolvedValue(optionsResponse([postiOption]))
    const { provider, client } = buildProvider({}, { fetchDeliveryOptions })

    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      { session_id: "expired" },
      validationContext()
    )

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/rejected the request for session expired/))
    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(fetchDeliveryOptions).toHaveBeenLastCalledWith("session-1", expect.anything())
    expect(data.session_id).toBe("session-1")
  })

  it("creates a new session when nShift reports the pinned one gone (410)", async () => {
    const fetchDeliveryOptions = jest
      .fn()
      .mockRejectedValueOnce(new NShiftApiError("nShift API error (410)", 410))
      .mockResolvedValue(optionsResponse([postiOption]))
    const { provider, client } = buildProvider({}, { fetchDeliveryOptions })

    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      { session_id: "gone" },
      validationContext()
    )

    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(fetchDeliveryOptions).toHaveBeenLastCalledWith("session-1", expect.anything())
    expect(data.session_id).toBe("session-1")
  })

  it("drops a stale sub-shipment id after falling back to a single session", async () => {
    const { provider } = buildProvider(
      {},
      {
        fetchSplitDeliveryOptions: jest
          .fn()
          .mockRejectedValue(new NShiftApiError("nShift API error (400)", 400)),
      }
    )

    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      { session_id: "split-x", sub_shipment_id: "sub-x", subShipmentId: "sub-x" },
      validationContext()
    )

    expect(data.session_id).toBe("session-1")
    expect(data).not.toHaveProperty("sub_shipment_id")
    expect(data).not.toHaveProperty("subShipmentId")
  })

  it("does not fall back on other nShift failures", async () => {
    const { provider, client } = buildProvider(
      {},
      {
        fetchDeliveryOptions: jest
          .fn()
          .mockRejectedValue(new NShiftApiError("nShift API error (503)", 503)),
      }
    )

    await expect(
      provider.validateFulfillmentData(
        { option_id: "posti" },
        { session_id: "pinned-1" },
        validationContext()
      )
    ).rejects.toThrow(/503/)
    expect(client.createSession).not.toHaveBeenCalled()
  })

  it("keeps calculatePrice non-throwing when the fallback also fails", async () => {
    const { provider } = buildProvider(
      {},
      {
        fetchDeliveryOptions: jest
          .fn()
          .mockRejectedValue(new NShiftApiError("nShift API error (404)", 404)),
      }
    )

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      { session_id: "expired" },
      cartContext()
    )

    expect("calculated_amount" in price).toBe(false)
  })

  it("ignores a bare session id in split mode", async () => {
    const { provider, client } = buildProvider({ split_shipments: true })

    await provider.calculatePrice(
      { option_id: "posti" },
      { session_id: "some-session" },
      cartContext()
    )

    expect(client.createSplitSession).toHaveBeenCalledTimes(1)
    expect(client.fetchSplitDeliveryOptions).toHaveBeenCalledWith(
      "split-1",
      expect.anything()
    )
  })

  it("does not share the cache between pinned and unpinned lookups", async () => {
    const { provider, client } = buildProvider()
    const context = cartContext()

    await provider.calculatePrice({ option_id: "posti" }, {}, context)
    await provider.calculatePrice({ option_id: "posti" }, { session_id: "pinned-1" }, context)

    expect(client.fetchDeliveryOptions).toHaveBeenCalledTimes(2)
    expect(client.fetchDeliveryOptions).toHaveBeenLastCalledWith("pinned-1", expect.anything())
  })
})

describe("preselected store", () => {
  it("passes preselected_store_id to the single fetch", async () => {
    const { provider, client } = buildProvider()

    await provider.calculatePrice(
      { option_id: "posti" },
      { preselected_store_id: "store-9" },
      cartContext()
    )

    expect(client.fetchDeliveryOptions).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ preselectedStoreId: "store-9" })
    )
    expect(client.createSession.mock.calls[0][0]).not.toHaveProperty("preselectedStoreId")
  })

  it("passes preselectedStoreId to the split sub-shipment", async () => {
    const { provider, client } = buildProvider({ split_shipments: true })

    await provider.calculatePrice(
      { option_id: "posti" },
      { preselectedStoreId: "store-9" },
      cartContext()
    )

    expect(client.fetchSplitDeliveryOptions).toHaveBeenCalledWith(
      "split-1",
      expect.objectContaining({
        subShipments: [expect.objectContaining({ preselectedStoreId: "store-9" })],
      })
    )
  })

  it("omits preselectedStoreId when none was sent", async () => {
    const { provider, client } = buildProvider()

    await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())

    expect(client.fetchDeliveryOptions.mock.calls[0][1]).not.toHaveProperty(
      "preselectedStoreId"
    )
  })
})

describe("storefront price data (calculated_price.nshift)", () => {
  const pickupPoint = {
    pickupPointId: "K384",
    name: "K-Market Kamppi",
    city: "Helsinki",
    openHoursWeekday: [{ firstWeekday: "MONDAY", lastWeekday: "FRIDAY", closed: false }],
  }
  const timeSlot = {
    timeSlotId: "slot-1",
    earliest: "2026-11-02T08:00:00Z",
    latest: "2026-11-02T12:00:00Z",
  }
  const pickupTimeSlot = { pickupTimeSlotId: "pts-1", pickupDate: "2026-11-01" }
  const field = { fieldId: "DOORCODE", title: "Door code", mandatory: false }
  const richOption: NShiftDeliveryOption = {
    ...postiOption,
    carrierName: "Posti",
    carrierProductName: "Parcel to pickup point",
    deliveryTime: { earliestDays: 1, latestDays: 2, description: "1-2 days" },
    pickupPoints: [pickupPoint],
    noDefaultPickupPoint: true,
    timeSlots: [timeSlot],
    pickupTimeSlots: [pickupTimeSlot],
    fields: [field],
    texts: ["Delivered to your nearest pickup point"],
    logoUrl: "https://cdn.example.com/posti.png",
    badges: [{ badgeId: "eco", title: "Eco" }],
    certifications: [{ certificationId: "c1", title: "Fossil free" }],
  }

  const expectedBlock = {
    option_id: "posti",
    name: "Posti home FI",
    carrier_name: "Posti",
    carrier_product_name: "Parcel to pickup point",
    price: 19,
    addons_price: 79,
    currency_code: "EUR",
    delivery_time: richOption.deliveryTime,
    pickup_points: [pickupPoint],
    no_default_pickup_point: true,
    time_slots: [timeSlot],
    pickup_time_slots: [pickupTimeSlot],
    addons: richOption.addons,
    fields: [field],
    texts: richOption.texts,
    logo_url: "https://cdn.example.com/posti.png",
    badges: richOption.badges,
    certifications: richOption.certifications,
  }

  it("returns the session and the option's details in single mode", async () => {
    const { provider } = buildProvider(
      {},
      { fetchDeliveryOptions: jest.fn().mockResolvedValue(optionsResponse([richOption])) }
    )

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      { addons: ["dangerous-goods"] },
      cartContext()
    )

    expect(price).toEqual({
      calculated_amount: 98,
      is_calculated_price_tax_inclusive: true,
      nshift: { session_id: "session-1", ...expectedBlock },
    })
    expect(price).not.toHaveProperty("nshift.sub_shipment_id")
  })

  it("returns the session and sub-shipment in split mode", async () => {
    const { provider } = buildProvider(
      { split_shipments: true },
      {
        createSplitSession: jest.fn().mockResolvedValue({
          sessionId: "split-1",
          subShipments: [{ subShipmentId: "split-1" }],
        }),
        fetchSplitDeliveryOptions: jest.fn().mockResolvedValue({
          sessionId: "split-1",
          subShipments: [{ subShipmentId: "split-1", options: [richOption] }],
        }),
      }
    )

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      { addons: ["dangerous-goods"] },
      cartContext()
    )

    expect(price).toEqual({
      calculated_amount: 98,
      is_calculated_price_tax_inclusive: true,
      nshift: { session_id: "split-1", sub_shipment_id: "split-1", ...expectedBlock },
    })
  })

  it("passes nShift's nested objects through without renaming them", async () => {
    const { provider } = buildProvider(
      {},
      { fetchDeliveryOptions: jest.fn().mockResolvedValue(optionsResponse([richOption])) }
    )

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())

    expect(price).toMatchObject({
      nshift: {
        pickup_points: [{ pickupPointId: "K384", openHoursWeekday: expect.any(Array) }],
        time_slots: [{ timeSlotId: "slot-1" }],
        pickup_time_slots: [{ pickupTimeSlotId: "pts-1" }],
        addons: [{ addonId: "dangerous-goods", price: 79 }],
        fields: [{ fieldId: "DOORCODE" }],
      },
    })
  })

  it("never exposes provider credentials", async () => {
    const { provider } = buildProvider(
      { client_id: "client-id-xyz", client_secret: "super-secret-xyz", connection_id: "conn-xyz" },
      { fetchDeliveryOptions: jest.fn().mockResolvedValue(optionsResponse([richOption])) }
    )

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())

    expect(JSON.stringify(price)).not.toMatch(/client-id-xyz|super-secret-xyz|conn-xyz/)
  })

  it("leaves the nshift block off an unavailable price", async () => {
    const { provider } = buildProvider(
      {},
      { fetchDeliveryOptions: jest.fn().mockResolvedValue(optionsResponse([schenkerOption])) }
    )

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())

    expect(price).toEqual({ is_calculated_price_tax_inclusive: true })
    expect(price).not.toHaveProperty("nshift")
  })
})

describe("Medusa-only pinning round trip", () => {
  /** The `data` a storefront sends to `addShippingMethod`, built from `calculated_price.nshift`. */
  const methodDataFrom = (
    price: Awaited<ReturnType<NShiftProviderService["calculatePrice"]>>,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => {
    if (!("nshift" in price)) {
      throw new Error("expected an available price")
    }
    return {
      session_id: price.nshift.session_id,
      ...(price.nshift.sub_shipment_id
        ? { sub_shipment_id: price.nshift.sub_shipment_id }
        : {}),
      ...extra,
    }
  }

  it("resolves the returned ids to the same cached single session", async () => {
    const { provider, client } = buildProvider()
    const context = cartContext()

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      { preselected_store_id: "store-9" },
      context
    )
    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      methodDataFrom(price, { preselected_store_id: "store-9" }),
      validationContext()
    )
    // Medusa recalculates the price with the persisted method data on refresh.
    const refreshed = await provider.calculatePrice({ option_id: "posti" }, data, context)

    expect(data.session_id).toBe("session-1")
    expect(refreshed).toMatchObject({ nshift: { session_id: "session-1" } })
    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(client.fetchDeliveryOptions).toHaveBeenCalledTimes(1)
    expect(client.updateSession).not.toHaveBeenCalled()
  })

  it("resolves the returned ids to the same cached split sub-shipment", async () => {
    const { provider, client } = buildProvider({ split_shipments: true })
    const context = cartContext()

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, context)
    const data = await provider.validateFulfillmentData(
      { option_id: "posti" },
      methodDataFrom(price),
      validationContext()
    )
    const refreshed = await provider.calculatePrice({ option_id: "posti" }, data, context)

    expect(data).toMatchObject({ session_id: "split-1", sub_shipment_id: "split-1" })
    expect(refreshed).toMatchObject({
      nshift: { session_id: "split-1", sub_shipment_id: "split-1" },
    })
    expect(client.createSplitSession).toHaveBeenCalledTimes(1)
    expect(client.fetchSplitDeliveryOptions).toHaveBeenCalledTimes(1)
    expect(client.updateSplitSession).not.toHaveBeenCalled()
  })

  it("updates a pinned single session once when the cart's address changes", async () => {
    const { provider, client } = buildProvider()

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())
    const moved = cartContext({
      shipping_address: { ...finnishAddress, postal_code: "33100", city: "Tampere" },
    })
    await provider.calculatePrice({ option_id: "posti" }, methodDataFrom(price), moved)
    await provider.calculatePrice({ option_id: "schenker" }, methodDataFrom(price), moved)

    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(client.updateSession).toHaveBeenCalledTimes(1)
    expect(client.updateSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        receiver: expect.objectContaining({ postalCode: "33100", city: "Tampere" }),
        includeInConversionRate: true,
      })
    )
    expect(client.fetchDeliveryOptions).toHaveBeenCalledTimes(2)
    expect(client.fetchDeliveryOptions).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({ receiver: expect.objectContaining({ postalCode: "33100" }) })
    )
    expect(client.updateSession.mock.invocationCallOrder[0]).toBeLessThan(
      client.fetchDeliveryOptions.mock.invocationCallOrder[1]
    )
  })

  it("updates a pinned split session with its single sub-shipment when items change", async () => {
    const { provider, client } = buildProvider({
      split_shipments: true,
      include_in_conversion_rate: false,
    })

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())
    const heavier = cartContext({
      items: [
        {
          id: "item_1",
          quantity: 4,
          unit_price: 10,
          total: 40,
          variant_sku: "SWEATSHIRT-XL",
          requires_shipping: true,
          variant: { weight: 0.5 },
        },
      ],
    })
    await provider.calculatePrice({ option_id: "posti" }, methodDataFrom(price), heavier)

    expect(client.updateSplitSession).toHaveBeenCalledTimes(1)
    expect(client.updateSplitSession).toHaveBeenCalledWith("split-1", {
      currencyCode: "EUR",
      languageCode: "en",
      localeId: "en-GB",
      receiver: expect.objectContaining({ postalCode: "00100" }),
      subShipments: [
        expect.objectContaining({ subShipmentId: "split-1", totalWeightKg: 2, totalPrice: 40 }),
      ],
      includeInConversionRate: false,
    })
    expect(client.fetchSplitDeliveryOptions).toHaveBeenLastCalledWith(
      "split-1",
      expect.objectContaining({
        subShipments: [expect.objectContaining({ subShipmentId: "split-1", totalWeightKg: 2 })],
      })
    )
  })

  it("falls back to a new session when the update is rejected", async () => {
    const { provider, client } = buildProvider(
      {},
      {
        updateSession: jest
          .fn()
          .mockRejectedValue(new NShiftApiError("nShift API error (404)", 404)),
      }
    )

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      { session_id: "expired" },
      cartContext()
    )

    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(price).toMatchObject({ calculated_amount: 19, nshift: { session_id: "session-1" } })
  })

  it("syncs the session back when the cart returns to a cached context (A -> B -> A)", async () => {
    const { provider, client } = buildProvider()
    const contextA = cartContext()
    const contextB = cartContext({
      shipping_address: { ...finnishAddress, postal_code: "33100", city: "Tampere" },
    })

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, contextA)
    const pinned = methodDataFrom(price)
    await provider.calculatePrice({ option_id: "posti" }, pinned, contextB)
    // Context A's options are still cached, but the session now holds context B.
    await provider.calculatePrice({ option_id: "posti" }, pinned, contextA)

    expect(client.updateSession).toHaveBeenCalledTimes(2)
    expect(client.updateSession).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({
        receiver: expect.objectContaining({ postalCode: "00100", city: "Helsinki" }),
      })
    )
    expect(client.fetchDeliveryOptions).toHaveBeenCalledTimes(3)

    // Back in sync: further lookups for A cost no nShift call.
    await provider.calculatePrice({ option_id: "schenker" }, pinned, contextA)
    expect(client.updateSession).toHaveBeenCalledTimes(2)
    expect(client.fetchDeliveryOptions).toHaveBeenCalledTimes(3)
  })

  it("updates a session once more after its sync state is evicted", async () => {
    const { provider, client } = buildProvider(
      {},
      {
        createSession: jest
          .fn()
          .mockResolvedValueOnce({ sessionId: "session-1" })
          .mockResolvedValueOnce({ sessionId: "session-2" }),
        fetchDeliveryOptions: jest
          .fn()
          .mockImplementation(async (sessionId: string) => ({
            sessionId,
            options: [postiOption],
          })),
      }
    )
    const syncedSessions = new BoundedMap<string>(1)
    Reflect.set(provider, "syncedSessions", syncedSessions)

    const price = await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())
    await provider.calculatePrice({ option_id: "posti" }, {}, cartContext({ id: "cart_2" }))

    expect(syncedSessions.size).toBe(1)
    expect(syncedSessions.has("session-1|")).toBe(false)
    expect(syncedSessions.has("session-2|")).toBe(true)

    // The primed entry for session-1 is still live, but its sync state is gone.
    await provider.calculatePrice({ option_id: "posti" }, methodDataFrom(price), cartContext())
    await provider.calculatePrice({ option_id: "posti" }, methodDataFrom(price), cartContext())

    expect(client.updateSession).toHaveBeenCalledTimes(1)
    expect(client.updateSession).toHaveBeenCalledWith("session-1", expect.anything())
    expect(client.fetchDeliveryOptions).toHaveBeenCalledTimes(3)
  })
})

describe("pinned sessions belong to their cart", () => {
  const echoSessionOptions = () =>
    jest.fn().mockImplementation(async (sessionId: string) => ({
      sessionId,
      options: [postiOption],
    }))

  it("ignores a session this process issued for another cart", async () => {
    const { provider, client } = buildProvider(
      {},
      {
        createSession: jest
          .fn()
          .mockResolvedValueOnce({ sessionId: "session-1" })
          .mockResolvedValueOnce({ sessionId: "session-2" }),
        fetchDeliveryOptions: echoSessionOptions(),
      }
    )

    await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())
    const hijacked = await provider.calculatePrice(
      { option_id: "posti" },
      { session_id: "session-1" },
      cartContext({ id: "cart_2" })
    )
    const validated = await provider.validateFulfillmentData(
      { option_id: "posti" },
      { session_id: "session-1" },
      validationContext({ id: "cart_2" })
    )

    expect(client.updateSession).not.toHaveBeenCalled()
    // Only cart_1's own lookup ran in session-1; cart_2 got a session of its own.
    expect(client.fetchDeliveryOptions.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "session-1",
      "session-2",
    ])
    expect(hijacked).toMatchObject({ nshift: { session_id: "session-2" } })
    expect(validated.session_id).toBe("session-2")
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("issued for a different cart")
    )
  })

  it("still honours the pin for the cart it was issued to", async () => {
    const { provider, client } = buildProvider({}, { fetchDeliveryOptions: echoSessionOptions() })

    await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())
    const price = await provider.calculatePrice(
      { option_id: "posti" },
      { session_id: "session-1" },
      cartContext()
    )

    expect(price).toMatchObject({ nshift: { session_id: "session-1" } })
    expect(client.createSession).toHaveBeenCalledTimes(1)
  })

  it("accepts a known pin when the context has no cart id", async () => {
    const { provider, client } = buildProvider({}, { fetchDeliveryOptions: echoSessionOptions() })

    await provider.calculatePrice({ option_id: "posti" }, {}, cartContext())
    const price = await provider.calculatePrice(
      { option_id: "posti" },
      { session_id: "session-1" },
      cartContext({ id: undefined })
    )

    expect(price).toMatchObject({ nshift: { session_id: "session-1" } })
    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("issued for a different cart")
    )
  })

  it("accepts a session this process does not know", async () => {
    const { provider, client } = buildProvider({}, { fetchDeliveryOptions: echoSessionOptions() })

    const price = await provider.calculatePrice(
      { option_id: "posti" },
      { session_id: "from-another-instance" },
      cartContext({ id: "cart_2" })
    )

    expect(client.createSession).not.toHaveBeenCalled()
    expect(client.updateSession).toHaveBeenCalledWith(
      "from-another-instance",
      expect.anything()
    )
    expect(price).toMatchObject({ nshift: { session_id: "from-another-instance" } })
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("issued for a different cart")
    )
  })
})

describe("stale and missing sessions at fulfillment", () => {
  const order = {
    id: "order_1",
    currency_code: "eur",
    shipping_address: finnishAddress,
    items: [{ id: "ordli_1", variant_sku: "SWEATSHIRT-XL", variant: { weight: 0.5 } }],
  } as unknown as Partial<FulfillmentOrderDTO>
  const items = [{ line_item_id: "ordli_1", quantity: 1, sku: "SWEATSHIRT-XL" }]

  it("a calculatePrice fallback leaves the stored session unchanged", async () => {
    const { provider, client } = buildProvider(
      {},
      {
        updateSession: jest
          .fn()
          .mockRejectedValue(new NShiftApiError("nShift API error (404)", 404)),
      }
    )
    const stored = { session_id: "expired", option_id: "posti" }

    // A cart refresh reprices with the stored data; Medusa only updates the amount.
    const price = await provider.calculatePrice({ option_id: "posti" }, stored, cartContext())

    expect(price).toMatchObject({ nshift: { session_id: "session-1" } })
    expect(stored).toEqual({ session_id: "expired", option_id: "posti" })
    expect(client.createSession).toHaveBeenCalledTimes(1)
  })

  it("createFulfillment recovers from a stale single session", async () => {
    const createPartialShipment = jest
      .fn()
      .mockRejectedValueOnce(
        new NShiftApiError("nShift API error (404) on /shipments/v1/shipments: Not Found", 404)
      )
      .mockResolvedValue({ id: "shipment-2", orderId: "order_1" })
    const { provider, client } = buildProvider({}, { createPartialShipment })

    const result = await provider.createFulfillment(
      { session_id: "expired", option_id: "posti", currency_code: "EUR" },
      items,
      order,
      {}
    )

    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        currencyCode: "EUR",
        receiver: expect.objectContaining({ postalCode: "00100" }),
      })
    )
    expect(createPartialShipment).toHaveBeenCalledTimes(2)
    expect(createPartialShipment).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "session-1", optionId: "posti" }),
      undefined
    )
    expect(result.data).toMatchObject({
      session_id: "expired",
      nshift_session_id: "session-1",
      nshift_shipment_id: "shipment-2",
    })
  })

  it("createFulfillment recovers from a stale split sub-shipment", async () => {
    const createSplitPartialShipments = jest
      .fn()
      .mockRejectedValueOnce(
        new NShiftApiError("nShift API error (400): Unknown session id sub-old", 400)
      )
      .mockResolvedValue({ shipments: [{ id: "shipment-s2", orderId: "order_1" }] })
    const { provider, client } = buildProvider({}, { createSplitPartialShipments })

    const result = await provider.createFulfillment(
      { session_id: "split-old", sub_shipment_id: "sub-old", option_id: "posti" },
      items,
      order,
      {}
    )

    expect(client.createSplitSession).toHaveBeenCalledTimes(1)
    expect(client.createSession).not.toHaveBeenCalled()
    expect(createSplitPartialShipments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "split-1",
        subShipments: [expect.objectContaining({ subShipmentId: "split-1", optionId: "posti" })],
      }),
      undefined
    )
    expect(result.data).toMatchObject({
      nshift_session_id: "split-1",
      nshift_sub_shipment_id: "split-1",
      nshift_shipment_id: "shipment-s2",
    })
  })

  it("refuses to rebook when the selected pickup point is gone", async () => {
    const createPartialShipment = jest
      .fn()
      .mockRejectedValue(new NShiftApiError("nShift API error (404)", 404))
    const { provider } = buildProvider({}, { createPartialShipment })

    await expect(
      provider.createFulfillment(
        { session_id: "expired", option_id: "posti", pickup_point_id: "K384" },
        items,
        order,
        {}
      )
    ).rejects.toThrow(/pickup point K384 is no longer offered/)
    expect(createPartialShipment).toHaveBeenCalledTimes(1)
  })

  describe("which booking failures rebuild the session", () => {
    const cases: Array<[string, Error, boolean]> = [
      [
        "400 mentioning the session",
        new NShiftApiError("nShift API error (400): Unknown session id", 400, [
          { issueCode: "UNKNOWN_SESSION", severity: "ERROR" },
        ]),
        true,
      ],
      [
        "400 without session text",
        new NShiftApiError("nShift API error (400): invalid pickup point", 400, [
          { issueCode: "INVALID_PICKUP_POINT", severity: "ERROR" },
        ]),
        true,
      ],
      ["404", new NShiftApiError("nShift API error (404): Not Found", 404), true],
      ["410", new NShiftApiError("nShift API error (410): Gone", 410), true],
      ["422", new NShiftApiError("nShift API error (422): Unprocessable", 422), false],
      ["500", new NShiftApiError("nShift API error (500): Internal", 500), false],
      [
        "a timeout (status 0)",
        new NShiftApiError("nShift request to /shipments timed out after 15000ms.", 0),
        false,
      ],
      ["a non-nShift error", new Error("socket hang up"), false],
    ]

    it.each(cases)("%s -> rebuild: %s", async (_label, error, rebuilds) => {
      const createPartialShipment = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ id: "shipment-2", orderId: "order_1" })
      const { provider, client } = buildProvider({}, { createPartialShipment })

      const attempt = provider.createFulfillment(
        { session_id: "old-session", option_id: "posti" },
        items,
        order,
        {}
      )

      if (!rebuilds) {
        await expect(attempt).rejects.toBe(error)
        expect(client.createSession).not.toHaveBeenCalled()
        expect(createPartialShipment).toHaveBeenCalledTimes(1)
        return
      }

      await expect(attempt).resolves.toMatchObject({
        data: { nshift_session_id: "session-1", nshift_shipment_id: "shipment-2" },
      })
      expect(client.createSession).toHaveBeenCalledTimes(1)
      expect(createPartialShipment).toHaveBeenCalledTimes(2)

      const status = error instanceof NShiftApiError ? error.status : -1
      const codes =
        error instanceof NShiftApiError && error.issues.length
          ? error.issues.map((issue) => issue.issueCode).join(", ")
          : "none"
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`with status ${status} (issue codes: ${codes})`)
      )
    })
  })

  describe("price drift after a rebuild", () => {
    const rebookAfter404 = () =>
      jest
        .fn()
        .mockRejectedValueOnce(new NShiftApiError("nShift API error (404)", 404))
        .mockResolvedValue({ id: "shipment-2", orderId: "order_1" })

    it("records nothing when nShift still charges the stored price", async () => {
      const { provider } = buildProvider({}, { createPartialShipment: rebookAfter404() })

      const result = await provider.createFulfillment(
        {
          session_id: "old-session",
          option_id: "posti",
          price: 98,
          addons: [{ addon_id: "dangerous-goods" }],
        },
        items,
        order,
        {}
      )

      expect(result.data).not.toHaveProperty("nshift_rebooked_price")
      expect(result.data).not.toHaveProperty("nshift_price_drift")
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("drift"))
    })

    it("records and logs a drift, including addons, but still books", async () => {
      const createPartialShipment = rebookAfter404()
      const { provider } = buildProvider({}, { createPartialShipment })

      const result = await provider.createFulfillment(
        {
          session_id: "old-session",
          option_id: "posti",
          price: 90.5,
          addons: [{ addon_id: "dangerous-goods" }],
        },
        items,
        order,
        {}
      )

      expect(createPartialShipment).toHaveBeenCalledTimes(2)
      expect(result.data).toMatchObject({
        nshift_shipment_id: "shipment-2",
        nshift_rebooked_price: 98,
        nshift_price_drift: 7.5,
      })
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("drift 7.5"))
    })

    it("does not compare when the method has no stored price", async () => {
      const { provider } = buildProvider({}, { createPartialShipment: rebookAfter404() })

      const result = await provider.createFulfillment(
        { session_id: "old-session", option_id: "posti" },
        items,
        order,
        {}
      )

      expect(result.data).not.toHaveProperty("nshift_price_drift")
    })
  })

  it("creates a session lazily when the shipping method has none", async () => {
    const { provider, client } = buildProvider()

    const result = await provider.createFulfillment({ option_id: "posti" }, items, order, {})

    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(client.createPartialShipment).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", optionId: "posti" }),
      undefined
    )
    expect(result.data).toMatchObject({ nshift_session_id: "session-1" })
  })

  it("creates a split session lazily in split mode", async () => {
    const { provider, client } = buildProvider({ split_shipments: true })

    const result = await provider.createFulfillment({ option_id: "posti" }, items, order, {})

    expect(client.createSplitSession).toHaveBeenCalledTimes(1)
    expect(result.data).toMatchObject({
      nshift_session_id: "split-1",
      nshift_sub_shipment_id: "split-1",
    })
  })

  it("refuses to lazily book an option nShift no longer offers", async () => {
    const { provider, client } = buildProvider(
      {},
      { fetchDeliveryOptions: jest.fn().mockResolvedValue(optionsResponse([schenkerOption])) }
    )

    await expect(
      provider.createFulfillment({ option_id: "posti" }, items, order, {})
    ).rejects.toThrow(/no longer offers delivery option posti/)
    expect(client.createPartialShipment).not.toHaveBeenCalled()
  })
})
