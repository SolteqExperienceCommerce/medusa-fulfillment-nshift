import {
  buildPackages,
  buildReceiver,
  describeMissingReceiverFields,
  isReceiverDeliverable,
  normalizeMethodData,
  sumAddonPrices,
  toFulfillmentOptionData,
  toNumber,
} from "../mappers"
import { NShiftDeliveryOption } from "../types"

describe("buildReceiver", () => {
  it("omits blank fields instead of sending empty strings", () => {
    // nShift answers 422 MISSING_POSTAL_CODE / MISSING_COUNTRY_CODE when these
    // fields are present but blank, which is what `|| ""` fallbacks produced.
    const receiver = buildReceiver(
      {
        first_name: "Test",
        last_name: "Person",
        address_1: "Mannerheimintie 1",
        address_2: "",
        city: "Helsinki",
        province: null,
        postal_code: "00100",
        country_code: "fi",
        phone: "  ",
      },
      {}
    )

    expect(receiver).toEqual({
      name: "Test Person",
      address1: "Mannerheimintie 1",
      city: "Helsinki",
      postalCode: "00100",
      country: "FI",
    })
    expect(Object.keys(receiver)).not.toContain("address2")
    expect(Object.keys(receiver)).not.toContain("state")
    expect(Object.keys(receiver)).not.toContain("phone")
  })

  it("uppercases the Medusa country code", () => {
    expect(buildReceiver({ country_code: "se" }, {}).country).toBe("SE")
  })

  it("falls back to default_state when the address has no province", () => {
    expect(buildReceiver({ country_code: "us" }, { default_state: "NY" }).state).toBe("NY")
  })

  it("falls back to the company for the receiver name", () => {
    expect(buildReceiver({ company: "Solteq Oy" }, {}).name).toBe("Solteq Oy")
  })

  it("returns an empty receiver for a missing address", () => {
    expect(buildReceiver(undefined, {})).toEqual({})
  })
})

describe("isReceiverDeliverable", () => {
  it("requires both a country and a postal code", () => {
    expect(isReceiverDeliverable({ country: "FI", postalCode: "00100" })).toBe(true)
    expect(isReceiverDeliverable({ country: "FI" })).toBe(false)
    expect(isReceiverDeliverable({ postalCode: "00100" })).toBe(false)
    expect(isReceiverDeliverable({})).toBe(false)
  })

  it("names what is missing", () => {
    expect(describeMissingReceiverFields({})).toEqual(["country", "postal code"])
    expect(describeMissingReceiverFields({ country: "FI" })).toEqual(["postal code"])
  })
})

describe("toNumber", () => {
  it("reads every BigNumberValue shape Medusa uses", () => {
    expect(toNumber(19)).toBe(19)
    expect(toNumber("19.5")).toBe(19.5)
    expect(toNumber({ value: "12.55", precision: 20 })).toBe(12.55)
    expect(toNumber(10n)).toBe(10)
  })

  it("returns undefined rather than NaN for unusable input", () => {
    expect(toNumber(undefined)).toBeUndefined()
    expect(toNumber(null)).toBeUndefined()
    expect(toNumber("")).toBeUndefined()
    expect(toNumber("abc")).toBeUndefined()
    expect(toNumber(Number.NaN)).toBeUndefined()
  })
})

describe("buildPackages", () => {
  const item = (overrides: Record<string, unknown> = {}) => ({
    quantity: 2,
    unit_price: 10,
    total: 25,
    variant_sku: "SWEATSHIRT-XL",
    requires_shipping: true,
    variant: { weight: 500, length: 20, width: 10, height: 5 },
    ...overrides,
  })

  it("converts gram weights to kilograms when weight_unit is g", () => {
    const { packages, totalWeightKg } = buildPackages([item()], { weight_unit: "g" })

    expect(packages[0].weightKg).toBe(1)
    expect(totalWeightKg).toBe(1)
    expect(packages[0].articles?.[0]).toMatchObject({
      articleNo: "SWEATSHIRT-XL",
      quantity: 2,
      weightKg: 0.5,
    })
  })

  it("treats variant weights as kilograms by default", () => {
    expect(buildPackages([item()], {}).totalWeightKg).toBe(1000)
  })

  it("sends the goods value so nShift price rules can evaluate", () => {
    expect(buildPackages([item()], {}).totalPrice).toBe(25)
  })

  it("can suppress the goods value", () => {
    expect(buildPackages([item()], { send_cart_total: false }).totalPrice).toBeUndefined()
  })

  it("derives volume from the variant dimensions", () => {
    // 20 x 10 x 5 cm x 2 items
    expect(buildPackages([item()], {}).totalVolumeCm3).toBe(2000)
  })

  it("skips items that do not require shipping", () => {
    const { packages } = buildPackages(
      [item(), item({ requires_shipping: false, variant_sku: "GIFTCARD" })],
      {}
    )
    expect(packages[0].articles).toHaveLength(1)
  })

  it("falls back to the configured package weight when nothing is known", () => {
    const { packages } = buildPackages(
      [item({ variant: undefined })],
      { default_package_weight_kg: 0.75 }
    )
    expect(packages[0].weightKg).toBe(0.75)
  })

  it("never emits NaN for a missing quantity", () => {
    const { packages } = buildPackages([item({ quantity: undefined })], {})
    expect(packages[0].articles?.[0].quantity).toBe(1)
  })
})

describe("normalizeMethodData", () => {
  it("accepts snake_case from a Medusa storefront", () => {
    expect(
      normalizeMethodData({
        session_id: "sess-1",
        pickup_point_id: "K384",
        time_slot_id: "slot-1",
        addons: [{ addon_id: "948058", fields: [{ field_id: "MOBILE", value: "+3581" }] }],
        fields: [{ field_id: "DOORCODE", value: "1234" }],
      })
    ).toEqual({
      session_id: "sess-1",
      option_id: undefined,
      pickup_point_id: "K384",
      time_slot_id: "slot-1",
      addons: [{ addonId: "948058", fields: [{ fieldId: "MOBILE", value: "+3581" }] }],
      fields: [{ fieldId: "DOORCODE", value: "1234" }],
    })
  })

  it("accepts the camelCase spelling from the nShift widget", () => {
    expect(
      normalizeMethodData({
        sessionId: "sess-2",
        optionId: "opt-2",
        pickupPointId: "K999",
        timeSlotId: "slot-2",
        addons: [{ addonId: "1" }],
      })
    ).toMatchObject({
      session_id: "sess-2",
      option_id: "opt-2",
      pickup_point_id: "K999",
      time_slot_id: "slot-2",
      addons: [{ addonId: "1" }],
    })
  })

  it("accepts plain addon ids and a fields map", () => {
    expect(
      normalizeMethodData({ addon_ids: ["948058"], fields: { DOORCODE: 1234 } })
    ).toMatchObject({
      addons: [{ addonId: "948058" }],
      fields: [{ fieldId: "DOORCODE", value: "1234" }],
    })
  })

  it("tolerates missing data", () => {
    expect(normalizeMethodData(undefined)).toEqual({
      session_id: undefined,
      option_id: undefined,
      pickup_point_id: undefined,
      time_slot_id: undefined,
      addons: [],
      fields: [],
    })
  })
})

describe("sumAddonPrices", () => {
  const option: NShiftDeliveryOption = {
    valid: true,
    optionId: "opt-1",
    name: "Posti home FI",
    addons: [{ addonId: "dangerous-goods", price: 79 }],
    hiddenAddons: [{ addonId: "insurance", price: 5 }],
  }

  it("adds visible and hidden addon prices", () => {
    expect(
      sumAddonPrices(option, [{ addonId: "dangerous-goods" }, { addonId: "insurance" }])
    ).toBe(84)
  })

  it("ignores addons that are not on the option", () => {
    expect(sumAddonPrices(option, [{ addonId: "unknown" }])).toBe(0)
  })

  it("is zero when nothing is selected", () => {
    expect(sumAddonPrices(option, [])).toBe(0)
  })
})

describe("toFulfillmentOptionData", () => {
  it("keeps id and option_id aligned and drops blank carrier fields", () => {
    expect(
      toFulfillmentOptionData({
        valid: true,
        optionId: "opt-1",
        name: "Posti home FI",
        carrierId: "948",
        carrierName: "",
        carrierProductId: "10543",
        carrierProductName: "Posti Home Parcel",
      })
    ).toEqual({
      id: "opt-1",
      option_id: "opt-1",
      name: "Posti home FI",
      carrier_id: "948",
      carrier_product_id: "10543",
      carrier_product_name: "Posti Home Parcel",
    })
  })

  it("falls back through title and carrier product name", () => {
    expect(
      toFulfillmentOptionData({
        valid: true,
        optionId: "opt-2",
        name: "",
        title: "DHL Paket International",
      }).name
    ).toBe("DHL Paket International")
  })
})
