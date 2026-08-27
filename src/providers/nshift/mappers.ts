import {
  NShiftArticle,
  NShiftDeliveryOption,
  NShiftDimensionUnit,
  NShiftDimensions,
  NShiftFieldValue,
  NShiftFulfillmentOptionData,
  NShiftOptions,
  NShiftPackage,
  NShiftReceiver,
  NShiftSelectedAddon,
  NShiftWeightUnit,
} from "./types"

/**
 * The subset of a Medusa line item this provider needs. Cart line items, order line
 * items and the ad-hoc items built for a partial shipment all satisfy it structurally,
 * which keeps the mappers usable from every entry point without casting.
 */
export type ShippableItem = {
  quantity?: unknown
  unit_price?: unknown
  total?: unknown
  variant_sku?: string | null
  variant_id?: string | null
  requires_shipping?: boolean
  /** Narrowed at runtime — order line items do not expose `variant` in their DTO. */
  variant?: unknown
}

/** Narrows an `unknown` to an indexable object without an unchecked cast. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Medusa addresses reach the provider from carts, orders and fulfillments alike. */
export type AddressLike = {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address_1?: string | null
  address_2?: string | null
  city?: string | null
  province?: string | null
  postal_code?: string | null
  country_code?: string | null
  phone?: string | null
  metadata?: Record<string, unknown> | null
}

const KG_PER_UNIT: Record<NShiftWeightUnit, number> = { g: 0.001, kg: 1 }
const CM_PER_UNIT: Record<NShiftDimensionUnit, number> = { mm: 0.1, cm: 1, m: 100 }

/**
 * Medusa exposes quantities and money as `BigNumberValue`, which may be a number,
 * a numeric string or a `{ value }` wrapper. Anything non-finite becomes `undefined`
 * so it can be omitted from the nShift payload rather than sent as `NaN`.
 */
export const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value === "bigint") {
    return Number(value)
  }
  if (value && typeof value === "object" && "value" in value) {
    return toNumber((value as { value: unknown }).value)
  }
  return undefined
}

/**
 * Reads `value.variant` when present. Order line item DTOs do not declare it even
 * though the resolved order Medusa passes to `createFulfillment` usually carries it.
 */
export const readVariant = (value: unknown): unknown =>
  isRecord(value) ? value.variant : undefined

/** Trims a value and returns `undefined` for anything empty. */
export const toTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

/** Rounds to `decimals` places, dropping values that are not usable. */
const round = (value: number | undefined, decimals: number): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Drops every `undefined` entry so nShift never receives an empty string where it
 * expects a value. This is the core of the delivery-option fix: nShift answers
 * `422 MISSING_POSTAL_CODE / MISSING_COUNTRY_CODE` when these fields are present
 * but blank, which is exactly what `""` fallbacks produced.
 */
const compact = <T extends object>(input: T): T => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value
    }
  }
  return result as T
}

// ── Receiver ──

export const buildReceiver = (
  address: AddressLike | null | undefined,
  options: Pick<NShiftOptions, "default_state">
): NShiftReceiver => {
  if (!address) {
    return {}
  }

  const name =
    [toTrimmedString(address.first_name), toTrimmedString(address.last_name)]
      .filter((part): part is string => !!part)
      .join(" ") || toTrimmedString(address.company)

  const country = toTrimmedString(address.country_code)

  return compact<NShiftReceiver>({
    name,
    address1: toTrimmedString(address.address_1),
    address2: toTrimmedString(address.address_2),
    postalCode: toTrimmedString(address.postal_code),
    city: toTrimmedString(address.city),
    // nShift expects a state/province for some markets; fall back to the configured default.
    state: toTrimmedString(address.province) ?? toTrimmedString(options.default_state),
    // Medusa stores ISO-3166-1 alpha-2 lowercase, nShift documents uppercase.
    country: country ? country.toUpperCase() : undefined,
    phone: toTrimmedString(address.phone),
  })
}

/**
 * nShift rejects a delivery-options request unless the receiver carries at least a
 * country and a postal code, so callers can skip the round trip entirely.
 */
export const isReceiverDeliverable = (receiver: NShiftReceiver): boolean =>
  !!receiver.country && !!receiver.postalCode

export const describeMissingReceiverFields = (receiver: NShiftReceiver): string[] => {
  const missing: string[] = []
  if (!receiver.country) {
    missing.push("country")
  }
  if (!receiver.postalCode) {
    missing.push("postal code")
  }
  return missing
}

// ── Packages ──

type PackageTotals = {
  packages: NShiftPackage[]
  totalWeightKg?: number
  totalVolumeCm3?: number
  totalPrice?: number
}

/** Measurements live on `item.variant`, which is not part of every Medusa item DTO. */
const readVariantMeasurement = (
  item: ShippableItem,
  key: "weight" | "length" | "width" | "height"
): number | undefined =>
  isRecord(item.variant) ? toNumber(item.variant[key]) : undefined

const buildDimensions = (
  item: ShippableItem,
  dimensionUnit: NShiftDimensionUnit
): NShiftDimensions | undefined => {
  const factor = CM_PER_UNIT[dimensionUnit]
  const dimensions = compact<NShiftDimensions>({
    lengthCm: round(mult(readVariantMeasurement(item, "length"), factor), 2),
    widthCm: round(mult(readVariantMeasurement(item, "width"), factor), 2),
    heightCm: round(mult(readVariantMeasurement(item, "height"), factor), 2),
  })
  return Object.keys(dimensions).length ? dimensions : undefined
}

const mult = (value: number | undefined, factor: number): number | undefined =>
  value === undefined ? undefined : value * factor

/**
 * Maps cart/order items into a single nShift package and derives the totals the
 * nShift rule engine evaluates (`totalWeightKg`, `totalVolumeCm3`, `totalPrice`).
 * Without those totals, configured price rules such as "free shipping above X"
 * can never match.
 */
export const buildPackages = (
  items: ShippableItem[] | undefined,
  options: Pick<
    NShiftOptions,
    "weight_unit" | "dimension_unit" | "default_package_weight_kg" | "send_cart_total"
  >
): PackageTotals => {
  const weightFactor = KG_PER_UNIT[options.weight_unit ?? "kg"]
  const dimensionUnit = options.dimension_unit ?? "cm"
  const fallbackWeightKg = options.default_package_weight_kg ?? 0.5

  const shippableItems = (items ?? []).filter(
    (item) => item.requires_shipping !== false
  )

  let weightKg = 0
  let volumeCm3 = 0
  let goodsValue = 0

  const articles: NShiftArticle[] = shippableItems.map((item) => {
    const quantity = Math.max(Math.round(toNumber(item.quantity) ?? 1), 1)
    const unitWeightKg = round(
      mult(readVariantMeasurement(item, "weight"), weightFactor),
      3
    )
    const dimensions = buildDimensions(item, dimensionUnit)

    if (unitWeightKg) {
      weightKg += unitWeightKg * quantity
    }
    if (dimensions?.lengthCm && dimensions.widthCm && dimensions.heightCm) {
      volumeCm3 += dimensions.lengthCm * dimensions.widthCm * dimensions.heightCm * quantity
    }
    goodsValue +=
      toNumber(item.total) ?? (toNumber(item.unit_price) ?? 0) * quantity

    return compact<NShiftArticle>({
      articleNo: toTrimmedString(item.variant_sku) ?? toTrimmedString(item.variant_id),
      quantity,
      weightKg: unitWeightKg,
      dimensions,
    })
  })

  const resolvedWeightKg = round(weightKg, 3) ?? round(fallbackWeightKg, 3)
  const resolvedVolumeCm3 = round(volumeCm3, 2)

  const pkg = compact<NShiftPackage>({
    weightKg: resolvedWeightKg,
    volumeCm3: resolvedVolumeCm3,
    articles: articles.length ? articles : undefined,
  })

  return compact<PackageTotals>({
    packages: Object.keys(pkg).length ? [pkg] : [],
    totalWeightKg: resolvedWeightKg,
    totalVolumeCm3: resolvedVolumeCm3,
    totalPrice:
      options.send_cart_total === false ? undefined : round(goodsValue, 2),
  })
}

// ── Delivery option → Medusa fulfillment option ──

export const toFulfillmentOptionData = (
  option: NShiftDeliveryOption
): NShiftFulfillmentOptionData =>
  compact<NShiftFulfillmentOptionData>({
    id: option.optionId,
    option_id: option.optionId,
    name:
      toTrimmedString(option.name) ??
      toTrimmedString(option.title) ??
      toTrimmedString(option.carrierProductName) ??
      option.optionId,
    carrier_id: toTrimmedString(option.carrierId),
    carrier_name: toTrimmedString(option.carrierName),
    carrier_product_id: toTrimmedString(option.carrierProductId),
    carrier_product_name: toTrimmedString(option.carrierProductName),
  })

// ── Storefront-supplied method data ──

export type NormalizedMethodData = {
  session_id?: string
  option_id?: string
  pickup_point_id?: string
  time_slot_id?: string
  addons: NShiftSelectedAddon[]
  fields: NShiftFieldValue[]
}

const normalizeFieldValues = (input: unknown): NShiftFieldValue[] => {
  if (Array.isArray(input)) {
    return input.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return []
      }
      const record = entry as Record<string, unknown>
      const fieldId =
        toTrimmedString(record.fieldId) ?? toTrimmedString(record.field_id)
      const value = record.value
      if (!fieldId || value === undefined || value === null) {
        return []
      }
      return [{ fieldId, value: String(value) }]
    })
  }

  if (input && typeof input === "object") {
    return Object.entries(input as Record<string, unknown>).flatMap(
      ([fieldId, value]) =>
        value === undefined || value === null
          ? []
          : [{ fieldId, value: String(value) }]
    )
  }

  return []
}

const normalizeAddons = (data: Record<string, unknown>): NShiftSelectedAddon[] => {
  const raw = data.addons ?? data.addon_ids ?? data.addonIds
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.flatMap((entry) => {
    if (typeof entry === "string") {
      const addonId = toTrimmedString(entry)
      return addonId ? [{ addonId }] : []
    }
    if (!entry || typeof entry !== "object") {
      return []
    }
    const record = entry as Record<string, unknown>
    const addonId =
      toTrimmedString(record.addonId) ?? toTrimmedString(record.addon_id)
    if (!addonId) {
      return []
    }
    const fields = normalizeFieldValues(record.fields)
    return [fields.length ? { addonId, fields } : { addonId }]
  })
}

/**
 * Accepts both the snake_case spelling a Medusa storefront naturally uses and the
 * camelCase spelling from the nShift widget payload.
 */
export const normalizeMethodData = (
  data: Record<string, unknown> | undefined | null
): NormalizedMethodData => {
  const input = data ?? {}

  return {
    session_id:
      toTrimmedString(input.session_id) ?? toTrimmedString(input.sessionId),
    option_id: toTrimmedString(input.option_id) ?? toTrimmedString(input.optionId),
    pickup_point_id:
      toTrimmedString(input.pickup_point_id) ??
      toTrimmedString(input.pickupPointId),
    time_slot_id:
      toTrimmedString(input.time_slot_id) ?? toTrimmedString(input.timeSlotId),
    addons: normalizeAddons(input),
    fields: normalizeFieldValues(input.fields),
  }
}

/** Sums the prices of the addons the customer selected on a delivery option. */
export const sumAddonPrices = (
  option: NShiftDeliveryOption,
  selected: NShiftSelectedAddon[]
): number => {
  if (!selected.length) {
    return 0
  }
  const available = [...(option.addons ?? []), ...(option.hiddenAddons ?? [])]
  return selected.reduce((total, { addonId }) => {
    const addon = available.find((candidate) => candidate.addonId === addonId)
    return total + (toNumber(addon?.price) ?? 0)
  }, 0)
}
