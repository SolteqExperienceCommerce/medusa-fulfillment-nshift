import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { PostDeliveryOptionsSchema } from "./validators"
import { NShiftClient } from "../../../../providers/nshift/client"
import { NShiftOptions, NShiftReceiver, NShiftPackage } from "../../../../providers/nshift/types"

export async function POST(
  req: MedusaRequest<PostDeliveryOptionsSchema>,
  res: MedusaResponse
) {
  const { cart_id } = req.validatedBody
  const query = req.scope.resolve("query")

  const { data: [cart] } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "currency_code",
      "shipping_address.*",
      "items.*",
      "items.variant.*",
    ],
    filters: { id: cart_id },
  })

  if (!cart) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Cart with id "${cart_id}" not found`
    )
  }

  const configModule = req.scope.resolve("configModule") as any
  const modules = configModule.modules || {}
  const fulfillmentConfig = modules["fulfillment"] ?? modules["@medusajs/medusa/fulfillment"]
  const providers = fulfillmentConfig?.options?.providers || fulfillmentConfig?.providers || []
  const providersList = Array.isArray(providers) ? providers : Object.values(providers)
  const nshiftProvider = providersList.find(
    (p: any) => p.id === "nshift"
  )

  if (!nshiftProvider?.options) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "nShift provider options not found in config"
    )
  }

  const options: NShiftOptions = nshiftProvider.options
  const client = new NShiftClient(options)

  const currencyCode = (cart.currency_code || "EUR").toUpperCase()
  const languageCode = options.language_code || "en"
  const localeId = options.locale_id || "en-GB"

  const address = cart.shipping_address as Record<string, unknown> | undefined
  const receiver: NShiftReceiver = address
    ? {
        name: [address.first_name, address.last_name].filter(Boolean).join(" ") ||
          (address.name as string) || "",
        address1: (address.address_1 as string) || "",
        address2: (address.address_2 as string) || "",
        postalCode: (address.postal_code as string) || "",
        city: (address.city as string) || "",
        state: (address.province as string) || "",
        country: (address.country_code as string) || "",
        email: (address.email as string) || "",
        phone: (address.phone as string) || "",
      }
    : {}

  const items = (cart.items || []) as any[]
  const totalWeightKg = items.reduce((sum: number, item: any) => {
    const weight = item.variant?.weight || 0
    return sum + weight * (item.quantity || 1)
  }, 0)

  const packages: NShiftPackage[] = [
    {
      weightKg: totalWeightKg || 0.5,
      articles: items.map((item: any) => ({
        articleNo: item.variant?.sku || "",
        quantity: item.quantity || 1,
        weightKg: item.variant?.weight || null,
      })),
    },
  ]

  const session = await client.createSession({
    currencyCode,
    languageCode,
    localeId,
    receiver,
    packages,
    includeInConversionRate: true,
  })

  const deliveryOptions = await client.fetchDeliveryOptions(
    session.sessionId,
    {
      currencyCode,
      languageCode,
      localeId,
      receiver,
      packages,
    }
  )

  return res.json({
    session_id: session.sessionId,
    options: deliveryOptions.options,
  })
}
