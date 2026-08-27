# @solteq-excom/medusa-fulfillment-nshift

[nShift Checkout](https://developers.nshiftone.com/checkout/getting-started) fulfillment provider for [Medusa v2](https://medusajs.com).

Brings nShift's delivery options into a Medusa storefront: real carrier options, real prices for the customer's address and basket, and a partial shipment created in nShift when the order is fulfilled.

- **Dynamic delivery options** — the options an admin can attach to a shipping option come straight from your nShift Checkout configuration.
- **Calculated pricing** — prices are fetched per cart, using the receiver address, package weight/volume and basket value, so nShift price rules (free shipping thresholds, weight bands, per-country pricing) apply.
- **Pickup points, time slots and addons** — selected at checkout, validated against nShift, and forwarded to the shipment.
- **Partial shipments** — created on fulfillment, deleted again when the fulfillment is cancelled.
- **Fails soft** — if nShift is unreachable or does not offer an option for a cart, that option is simply reported as unavailable. Checkout keeps working.
- **Token and session handling** — OAuth2 tokens are cached and refreshed; one nShift session is reused across all the options of a cart.

## Requirements

- Medusa `>= 2.13.3`
- Node `>= 20`
- An active nShift Checkout agreement

## Installation

```bash
yarn add @solteq-excom/medusa-fulfillment-nshift
# or
npm install @solteq-excom/medusa-fulfillment-nshift
```

## nShift account setup

1. Log in to the [nShift Portal](https://www.nshiftportal.com/).
2. **Settings → API Configuration → Clients → Add.** Give the client the **Public checkout API** scope and copy the Client ID and Client Secret (the secret is only shown once).
3. **Connections** — copy the Connection ID you want Medusa to use.
4. Configure the Checkout configuration behind that connection with the carriers and delivery options you want to offer.

## Configuration

Register the provider on the Fulfillment Module, and register the plugin so its build output is loaded:

```ts
// medusa-config.ts
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  plugins: [
    {
      resolve: "@solteq-excom/medusa-fulfillment-nshift",
      options: {},
    },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/fulfillment-manual",
            id: "manual",
          },
          {
            resolve: "@solteq-excom/medusa-fulfillment-nshift/providers/nshift",
            id: "nshift",
            options: {
              client_id: process.env.NSHIFT_CLIENT_ID,
              client_secret: process.env.NSHIFT_CLIENT_SECRET,
              connection_id: process.env.NSHIFT_CONNECTION_ID,
              language_code: process.env.NSHIFT_LANGUAGE_CODE,
              locale_id: process.env.NSHIFT_LOCALE_ID,
              default_country: process.env.NSHIFT_DEFAULT_COUNTRY,
              default_postal_code: process.env.NSHIFT_DEFAULT_POSTAL_CODE,
              send_to_book_and_print:
                process.env.NSHIFT_SEND_TO_BOOK_AND_PRINT === "true",
            },
          },
        ],
      },
    },
  ],
})
```

> Define the Fulfillment Module **once**. If it appears twice in `modules`, the last definition wins and the provider in the earlier one is never registered — which makes every cart that references an nShift shipping option fail.

```env
NSHIFT_CLIENT_ID=your_client_id
NSHIFT_CLIENT_SECRET=your_client_secret
NSHIFT_CONNECTION_ID=your_connection_id
NSHIFT_LANGUAGE_CODE=en
NSHIFT_LOCALE_ID=en-GB
NSHIFT_DEFAULT_COUNTRY=FI
NSHIFT_DEFAULT_POSTAL_CODE=00100
NSHIFT_SEND_TO_BOOK_AND_PRINT=false
```

> If your client secret contains `$`, do not escape it as `\$` in `.env` — dotenv keeps the backslash and nShift answers `invalid_client`. Wrap the value in quotes instead.

### Provider options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `client_id` | `string` | — | **Required.** nShift API Client ID. |
| `client_secret` | `string` | — | **Required.** nShift API Client Secret. |
| `connection_id` | `string` | — | **Required.** nShift Checkout Connection ID. |
| `language_code` | `string` | `"en"` | Language for option names and descriptions (ISO 639). |
| `locale_id` | `string` | `"en-GB"` | Locale for formatted price/date strings. |
| `default_country` | `string` | — | Country used to list delivery options in the admin (ISO 3166-1 alpha-2). Required for the admin dropdown. |
| `default_postal_code` | `string` | — | Postal code used to list delivery options in the admin. Required for the admin dropdown. |
| `default_state` | `string` | — | State/province sent when the Medusa address has none. Some markets need it. |
| `default_currency` | `string` | `"EUR"` | Currency used when the calculation context carries none. |
| `prices_tax_inclusive` | `boolean` | `true` | Whether nShift prices already include tax. |
| `weight_unit` | `"g" \| "kg"` | `"kg"` | Unit of `variant.weight` in your data. Set to `"g"` if you store grams. |
| `dimension_unit` | `"mm" \| "cm" \| "m"` | `"cm"` | Unit of `variant.length` / `width` / `height`. |
| `default_package_weight_kg` | `number` | `0.5` | Weight sent when no item weights are known. |
| `send_cart_total` | `boolean` | `true` | Send the basket value as `totalPrice` so nShift price rules can evaluate. |
| `send_to_book_and_print` | `boolean` | `false` | Push partial shipments to your Book & Print platform. |
| `include_in_conversion_rate` | `boolean` | `true` | Count sessions towards nShift's conversion-rate metric. |
| `request_timeout_ms` | `number` | `15000` | Per-request timeout against the nShift API. |
| `options_cache_ttl_ms` | `number` | `30000` | How long one session and its delivery options are reused for an unchanged cart. |
| `api_base_url` | `string` | `https://api.nshiftportal.com/checkout` | Override the nShift API host. |
| `auth_url` | `string` | `https://account.nshiftportal.com/idp/connect/token` | Override the nShift token endpoint. |

**Check `weight_unit`.** Medusa does not define a unit for `variant.weight`. The default `"kg"` matches earlier versions of this plugin; if your catalogue stores grams, set `weight_unit: "g"` or nShift will price a 500 g shirt as 500 kg.

**Check `prices_tax_inclusive`.** nShift Checkout prices are normally the consumer-facing gross price, hence the `true` default. Set it to `false` if your configuration holds net prices, otherwise your cart's tax totals will be wrong.

## Creating shipping options in the admin

1. **Settings → Locations & Shipping →** your location → **Shipping options → Create.**
2. Set **Price type** to **Calculated** so the price comes from nShift.
3. Pick **nShift** as the provider and choose one of the delivery options it lists. Each Medusa shipping option maps to exactly one nShift delivery option.

The chosen delivery option is stored on `shipping_option.data.option_id`. If that dropdown is empty or errors, the message tells you why — most often a missing `default_country` / `default_postal_code`, or no delivery options configured for that country.

## Storefront usage

Calculated options come back from `GET /store/shipping-options` without a price; fetch each price with `POST /store/shipping-options/:id/calculate`, then add the method to the cart.

```ts
import { sdk } from "../lib/config"

// 1. List the options available for the cart.
const { shipping_options } = await sdk.store.fulfillment.listCartOptions({
  cart_id: cart.id,
})

// 2. Price the calculated ones.
const priced = await Promise.all(
  shipping_options.map(async (option) => {
    if (option.price_type !== "calculated") {
      return option
    }
    const { shipping_option } = await sdk.store.fulfillment.calculate(option.id, {
      cart_id: cart.id,
      data: {},
    })
    return shipping_option
  })
)

// 3. Hide the ones nShift does not offer for this cart.
const selectable = priced.filter((option) => option.amount !== undefined)

// 4. Add the customer's choice to the cart.
await sdk.store.cart.addShippingMethod(cart.id, {
  option_id: selected.id,
  data: {
    pickup_point_id: "K384",              // optional
    time_slot_id: "slot-1",               // optional
    addons: [{ addon_id: "948058" }],     // optional
    fields: [{ field_id: "DOORCODE", value: "1234" }], // optional
  },
})
```

### `data` accepted when adding a shipping method

Both snake_case and the nShift widget's camelCase spelling are accepted.

| Key | Alias | Description |
| --- | --- | --- |
| `pickup_point_id` | `pickupPointId` | A `pickupPointId` from the option's `pickupPoints`. |
| `time_slot_id` | `timeSlotId` | A `timeSlotId` from the option's `timeSlots`. |
| `addons` | — | `[{ addon_id, fields?: [{ field_id, value }] }]`, or `[{ addonId, ... }]`. |
| `addon_ids` | `addonIds` | Shorthand: `["948058"]`. |
| `fields` | — | `[{ field_id, value }]` or a `{ FIELDID: value }` map. |

Selections are validated against the delivery option before the method is stored: an unknown pickup point, time slot or addon is rejected with a `400` naming it. Addon prices are added to the shipping price.

Anything else you put in `data` is preserved verbatim, so you can carry your own state through checkout.

### What ends up on the shipping method

```json
{
  "session_id": "77933415-a756-4eab-821a-98fb6fc9aa75",
  "option_id": "834827b2-abc2-4e05-8520-7707c1d2c4d8",
  "carrier_id": "948",
  "carrier_product_id": "10543",
  "carrier_product_name": "Posti Home Parcel (2104)(10543) Finland only",
  "price": 98,
  "currency_code": "EUR",
  "addons": [{ "addonId": "948058" }],
  "delivery_time": {
    "earliest": "2026-08-29T00:00:00",
    "latest": "2026-08-29T00:00:00",
    "description": "Delivery on Saturday",
    "timeZone": "Europe/Helsinki"
  }
}
```

After fulfillment, `fulfillment.data` additionally carries `nshift_shipment_id`, `nshift_order_id`, `nshift_carrier` and `nshift_carrier_product`.

## Behaviour and error handling

The provider never breaks a cart. `calculatePrice` reports an option as **unavailable** — no `calculated_amount` — instead of throwing, whenever:

- the cart has no country or postal code yet,
- nShift does not return the option for that address (wrong country route, weight over the limit, a price rule excluding it),
- nShift returns the option without a price,
- the nShift API is unreachable, times out or errors,
- the shipping option has no nShift delivery option attached.

Medusa treats a missing price as "not available in this context": `refreshCartShippingMethodsWorkflow` removes the shipping method, and an explicit selection is rejected with `400 … do not have a price`. So changing the shipping country to one a carrier does not serve drops that method rather than failing the address update. Every case is logged with the nShift status and `issues[]` so you can see the reason in the server log.

Errors are raised where they are actionable instead:

| Situation | Result |
| --- | --- |
| Missing `client_id` / `client_secret` / `connection_id` | throws at startup |
| Admin option list without `default_country` / `default_postal_code` | `400` naming the missing option |
| Admin option list, nShift request fails | `400` including the nShift status and issues |
| Selecting an option nShift no longer offers | `400`, pick another method |
| Unknown pickup point, time slot or addon | `400` naming it |
| Option requires a pickup point and none was sent | `400` |
| Fulfilling without checkout session data | `400` |
| Order address nShift cannot ship to | `400` |
| nShift refuses to delete a cancelled shipment | logged, cancellation still succeeds |

## Not covered yet

- Split shipments (nShift's `/split-shipments/*` endpoints).
- Return shipments — `createReturnFulfillment` is not implemented.
- Labels and tracking numbers: booking and printing still happen in your Book & Print platform, so `createFulfillment` returns no `labels`.
- Own Pickup Locations API management.
- Badges, certifications and Klarna delivery types are read from nShift but not surfaced on the shipping method.

## License

MIT
