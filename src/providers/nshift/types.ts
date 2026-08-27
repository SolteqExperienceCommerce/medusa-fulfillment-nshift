/**
 * nShift Checkout API types
 * Based on: https://developers.nshiftone.com/checkout/getting-started
 *
 * Endpoints used by this provider:
 *   POST {api_base_url}/options/v1/sessions/{connectionId}    → create session
 *   POST {api_base_url}/options/v1/shipping-options/{session} → fetch delivery options
 *   POST {api_base_url}/shipments/v1/shipments                → create partial shipment
 */

// ── Module Options ──

export type NShiftWeightUnit = "g" | "kg"
export type NShiftDimensionUnit = "mm" | "cm" | "m"

export type NShiftOptions = {
  /** nShift API Client ID */
  client_id: string
  /** nShift API Client Secret */
  client_secret: string
  /** nShift Checkout Connection ID */
  connection_id: string
  /** Default language code (ISO 639), e.g. "en" */
  language_code?: string
  /** Default locale ID, e.g. "en-GB" */
  locale_id?: string
  /** Default country code (ISO 3166-1 alpha-2) used to fetch fulfillment options in admin, e.g. "FI" */
  default_country?: string
  /** Default postal code used to fetch fulfillment options in admin, e.g. "00100" */
  default_postal_code?: string
  /** Default state/province, used when the Medusa address has none and nShift requires one */
  default_state?: string
  /** Currency used when the calculation context does not carry one. Defaults to "EUR". */
  default_currency?: string
  /** Whether to send partial shipments to nShift Book & Print */
  send_to_book_and_print?: boolean
  /**
   * Whether the prices returned by nShift already include tax.
   * nShift Checkout prices are configured as consumer-facing (gross) prices, so this
   * defaults to `true`. Set to `false` if your configuration holds net prices.
   */
  prices_tax_inclusive?: boolean
  /**
   * Unit of `variant.weight` in your Medusa data, used to convert to nShift's kilograms.
   * Defaults to "kg" to preserve the behaviour of earlier plugin versions.
   */
  weight_unit?: NShiftWeightUnit
  /**
   * Unit of `variant.length` / `width` / `height` in your Medusa data, used to convert to
   * nShift's centimetres. Defaults to "cm".
   */
  dimension_unit?: NShiftDimensionUnit
  /** Package weight (kg) sent when no item weights are known. Defaults to 0.5. Set to 0 to omit. */
  default_package_weight_kg?: number
  /**
   * Send the cart's goods value as `totalPrice` so nShift price rules (e.g. free shipping
   * above a threshold) can evaluate. Defaults to `true`.
   */
  send_cart_total?: boolean
  /** Whether sessions count towards the nShift conversion rate metric. Defaults to `true`. */
  include_in_conversion_rate?: boolean
  /** Per-request timeout in milliseconds. Defaults to 15000. */
  request_timeout_ms?: number
  /**
   * How long a session and its delivery options are reused for an unchanged checkout
   * context, in milliseconds. Defaults to 30000.
   */
  options_cache_ttl_ms?: number
  /** Override the nShift API base URL. Defaults to "https://api.nshiftportal.com/checkout". */
  api_base_url?: string
  /** Override the nShift token endpoint. Defaults to "https://account.nshiftportal.com/idp/connect/token". */
  auth_url?: string
}

// ── Auth ──

export type NShiftTokenResponse = {
  access_token: string
  expires_in: number
  token_type: string
}

// ── Shared ──

export type NShiftIssueSeverity = "ERROR" | "WARNING" | "INFO" | string

export type NShiftIssue = {
  issueCode: string
  severity: NShiftIssueSeverity
  location?: string
  description?: string
}

/** RFC 7807-style error body returned by the nShift Checkout API. */
export type NShiftProblemResponse = {
  type?: string
  title?: string
  status?: string | number
  detail?: string
  instance?: string
  issues?: NShiftIssue[]
}

// ── Session ──

export type NShiftReceiver = {
  name?: string
  address1?: string
  address2?: string
  postalCode?: string
  city?: string
  state?: string
  country?: string
  email?: string
  phone?: string
  mobile?: string
  doorCode?: string
  houseNumber?: string
  addition?: string
  timeZone?: string
  contact?: string
  longitude?: string
  latitude?: string
}

export type NShiftDimensions = {
  lengthCm?: number | null
  widthCm?: number | null
  heightCm?: number | null
}

export type NShiftArticle = {
  articleNo?: string
  quantity?: number | null
  volumeCm3?: number | null
  weightKg?: number | null
  dimensions?: NShiftDimensions
  tags?: string[]
}

export type NShiftPackage = {
  weightKg?: number | null
  volumeCm3?: number | null
  dimensions?: NShiftDimensions
  contents?: string
  articles?: NShiftArticle[]
}

/** Body shared by create-session and fetch-delivery-options. */
export type NShiftContextPayload = {
  currencyCode: string
  languageCode: string
  localeId: string
  totalVolumeCm3?: number | null
  totalWeightKg?: number | null
  totalPrice?: number | null
  receiver?: NShiftReceiver
  packages?: NShiftPackage[]
  variables?: Record<string, unknown>
}

export type CreateSessionRequest = NShiftContextPayload & {
  includeInConversionRate?: boolean
}

export type CreateSessionResponse = {
  sessionId: string
  groupId?: string
  checkoutConfigurationId?: string
  created?: string
  checkoutVersion?: number | null
  includeInConversionRate?: boolean
  internal?: boolean
}

// ── Delivery Options ──

export type FetchDeliveryOptionsRequest = NShiftContextPayload

export type NShiftField = {
  fieldId: string
  title?: string
  mandatory?: boolean
  initialValue?: string
  min?: number | null
  max?: number | null
  pattern?: string
  valueItems?: { name: string; value: string }[]
}

export type NShiftAddon = {
  addonId: string
  title?: string
  preselected?: boolean
  mandatory?: boolean
  hidden?: boolean
  priceDescription?: string
  price?: number | null
  originalPriceDescription?: string
  originalPrice?: number | null
  oneOf?: string[]
  atLeastOneOf?: string[]
  exclude?: string[]
  dependency?: string[]
  fields?: NShiftField[]
  additionalValues?: Record<string, unknown>
}

export type NShiftDeliveryTime = {
  earliest?: string
  latest?: string
  cutoff?: string
  timeZone?: string
  earliestDays?: number | null
  latestDays?: number | null
  earliestWorkDays?: number | null
  latestWorkDays?: number | null
  description?: string
}

export type NShiftPickupPoint = {
  pickupPointId: string
  distance?: number | null
  latitude?: number | null
  longitude?: number | null
  name?: string
  address1?: string
  address2?: string
  houseNumber?: string
  houseNumberAddition?: string
  city?: string
  countryCode?: string
  postalCode?: string
  state?: string
  contact?: string
  phone?: string
  mobile?: string
  email?: string
  type?: string
  [k: string]: unknown
}

export type NShiftTimeSlot = {
  timeSlotId: string
  description?: string
  descriptionParts?: string[]
  earliest?: string
  latest?: string
  cutoff?: string
  timeZone?: string
  timeSlotToken?: string
  externalTimeSlotToken?: string
}

export type NShiftBadge = {
  badgeId?: string
  title?: string
  color?: string
  [k: string]: unknown
}

export type NShiftCertification = {
  certificationId?: string
  title?: string
  [k: string]: unknown
}

export type NShiftDeliveryOption = {
  valid: boolean
  optionId: string
  categoryId?: string
  name: string
  title?: string
  carrierId?: string
  carrierProductId?: string
  carrierProductVersion?: number | null
  carrierProductName?: string
  carrierProductSourceSystem?: string
  sourceSystemCarrierId?: string
  sourceSystemProductId?: string
  externalSystemCustomCarrier?: string
  texts?: string[]
  priceDescription?: string
  price?: number | null
  originalPriceDescription?: string
  originalPrice?: number | null
  taxRate?: number | null
  logoId?: string
  logoUrl?: string
  carrierName?: string
  customCarrier?: boolean
  addons?: NShiftAddon[]
  hiddenAddons?: NShiftAddon[]
  fields?: NShiftField[]
  deliveryTime?: NShiftDeliveryTime
  pickupPoints?: NShiftPickupPoint[]
  timeSlots?: NShiftTimeSlot[]
  externalSystemExtra?: Record<string, unknown>
  noDefaultPickupPoint?: boolean
  additionalValues?: Record<string, unknown>
  certifications?: NShiftCertification[]
  badges?: NShiftBadge[]
  klarnaBadges?: NShiftBadge[]
  tags?: string[]
  additionalMerchantInfo?: string
  klarnaDeliveryType?: string
  klarnaNeutralDeliveryType?: string
  [k: string]: unknown
}

export type FetchDeliveryOptionsResponse = {
  optionsVersion?: string
  sessionId: string
  subShipmentId?: string
  checkoutId?: string
  checkoutVersion?: string
  language?: string
  options: NShiftDeliveryOption[]
  addons?: NShiftAddon[]
  hiddenAddons?: NShiftAddon[]
  fields?: NShiftField[]
  categories?: { categoryId: string; title: string }[]
  issues?: NShiftIssue[]
}

// ── Partial Shipment ──

export type NShiftFieldValue = {
  fieldId: string
  value: string
}

export type NShiftSelectedAddon = {
  addonId: string
  fields?: NShiftFieldValue[]
}

export type CreatePartialShipmentRequest = {
  orderId: string
  sessionId: string
  optionId: string
  pickupPointId?: string
  timeSlotId?: string
  receiver: NShiftReceiver
  addons?: NShiftSelectedAddon[]
  fields?: NShiftFieldValue[]
  packages?: NShiftPackage[]
}

export type NShiftSender = {
  name?: string
  address1?: string
  address2?: string
  postalCode?: string
  city?: string
  state?: string
  country?: string
  houseNumber?: string
  addition?: string
  email?: string
  phone?: string
  mobile?: string
}

export type PartialShipmentResponse = {
  id: string
  organizationId?: string
  organizationUnitId?: string
  memberAccountId?: string
  orderId?: string
  carrier?: string
  carrierProduct?: string
  carrierProductVersion?: number | null
  created?: string
  sender?: NShiftSender
  receiver?: NShiftReceiver
  pickupPoint?: NShiftPickupPoint
  addons?: NShiftSelectedAddon[]
  fields?: Record<string, unknown>
  packages?: NShiftPackage[]
}

// ── Provider data contracts ──

/**
 * Shape stored on `shipping_option.data` — this is what `getFulfillmentOptions`
 * returns and what comes back as `optionData` in `calculatePrice` /
 * `validateFulfillmentData`.
 */
export type NShiftFulfillmentOptionData = {
  /** Medusa requires `id`; mirrors `option_id`. */
  id: string
  /** nShift `optionId` of the delivery option. */
  option_id: string
  name: string
  carrier_id?: string
  carrier_name?: string
  carrier_product_id?: string
  carrier_product_name?: string
}

/**
 * Shape stored on `shipping_method.data` (and later `fulfillment.data`).
 * Everything a storefront may send is accepted in both snake_case and the
 * nShift camelCase spelling; see `normalizeMethodData`.
 */
export type NShiftMethodData = {
  session_id: string
  option_id: string
  carrier_id?: string
  carrier_name?: string
  carrier_product_id?: string
  carrier_product_name?: string
  pickup_point_id?: string
  pickup_point?: NShiftPickupPoint
  time_slot_id?: string
  time_slot?: NShiftTimeSlot
  addons?: NShiftSelectedAddon[]
  fields?: NShiftFieldValue[]
  price?: number
  currency_code?: string
  delivery_time?: NShiftDeliveryTime
  /** Anything else the storefront sent is preserved verbatim. */
  [k: string]: unknown
}

/** Shape stored on `fulfillment.data` after a partial shipment is created. */
export type NShiftFulfillmentData = {
  nshift_shipment_id: string
  nshift_order_id?: string
  nshift_carrier?: string
  nshift_carrier_product?: string
}
