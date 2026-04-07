/**
 * nShift Checkout API types
 * Based on: https://developers.nshiftone.com/checkout/getting-started
 */

// ── Module Options ──

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
  /** Whether to send partial shipments to nShift Book & Print */
  send_to_book_and_print?: boolean
}

// ── Auth ──

export type NShiftTokenResponse = {
  access_token: string
  expires_in: number
  token_type: string
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

export type NShiftArticle = {
  articleNo?: string
  quantity?: number | null
  volumeCm3?: number | null
  weightKg?: number | null
  dimensions?: NShiftDimensions
  tags?: string[]
}

export type NShiftDimensions = {
  lengthCm?: number | null
  widthCm?: number | null
  heightCm?: number | null
}

export type NShiftPackage = {
  weightKg?: number | null
  volumeCm3?: number | null
  dimensions?: NShiftDimensions
  contents?: string
  articles?: NShiftArticle[]
}

export type CreateSessionRequest = {
  currencyCode: string
  languageCode: string
  localeId: string
  totalVolumeCm3?: number | null
  totalWeightKg?: number | null
  totalPrice?: number | null
  receiver?: NShiftReceiver
  packages?: NShiftPackage[]
  variables?: Record<string, unknown>
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

export type FetchDeliveryOptionsRequest = {
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
  tags?: string[]
  additionalMerchantInfo?: string
  [k: string]: unknown
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
  issues?: { issueCode: string; severity: string; location: string; description: string }[]
}

// ── Partial Shipment ──

export type CreatePartialShipmentRequest = {
  orderId: string
  sessionId: string
  optionId: string
  pickupPointId?: string
  timeSlotId?: string
  receiver: NShiftReceiver
  addons?: { addonId: string; fields?: { fieldId: string; value: string }[] }[]
  fields?: { fieldId: string; value: string }[]
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
  addons?: { addonId: string; fields?: { fieldId: string; value: string }[] }[]
  fields?: Record<string, unknown>
  packages?: NShiftPackage[]
}
