# @solteq-excom/medusa-fulfillment-nshift

[nShift Checkout](https://developers.nshiftone.com/checkout/getting-started) fulfillment provider for [Medusa v2](https://medusajs.com): live carrier options and prices per cart, pickup points, time slots, addons, optional split shipments, and a partial shipment created in nShift on fulfillment.

## Requirements

- Medusa `^2.13.3`. Verified on Medusa 2.19.0; adding several shipping methods in one `addShippingMethod` call needs Medusa >= 2.16.
- Node `>= 20`
- An active nShift Checkout agreement

## Installation

```bash
npm install @solteq-excom/medusa-fulfillment-nshift
```

## Configuration

Register the plugin and the provider on the Fulfillment Module:

```ts
// medusa-config.ts
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  plugins: [
    { resolve: "@solteq-excom/medusa-fulfillment-nshift", options: {} },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          { resolve: "@medusajs/medusa/fulfillment-manual", id: "manual" },
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
              split_shipments: process.env.NSHIFT_SPLIT_SHIPMENTS === "true",
            },
          },
        ],
      },
    },
  ],
})
```

> Define the Fulfillment Module **once**. If it appears twice in `modules`, the last definition wins and the provider in the earlier one is never registered, so every cart with an nShift shipping option fails.

```env
NSHIFT_CLIENT_ID=your_client_id
NSHIFT_CLIENT_SECRET=your_client_secret
NSHIFT_CONNECTION_ID=your_connection_id
NSHIFT_LANGUAGE_CODE=en
NSHIFT_LOCALE_ID=en-GB
NSHIFT_DEFAULT_COUNTRY=FI
NSHIFT_DEFAULT_POSTAL_CODE=00100
NSHIFT_SEND_TO_BOOK_AND_PRINT=false
NSHIFT_SPLIT_SHIPMENTS=false
```

Get the credentials in the [nShift Portal](https://www.nshiftportal.com/): **Settings > API Configuration > Clients > Add** with the **Public checkout API** scope (the secret is shown once), and the Connection ID under **Connections**.

If the client secret contains `$`, escape every `$` as `\$`. Quotes alone don't help, because Medusa expands `$VAR` references.

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
| `default_state` | `string` | — | State/province sent when the Medusa address has none. |
| `default_currency` | `string` | `"EUR"` | Currency used when the calculation context carries none. |
| `prices_tax_inclusive` | `boolean` | `true` | Whether nShift prices already include tax. Set `false` if your configuration holds net prices, or cart tax totals will be wrong. |
| `weight_unit` | `"g" \| "kg"` | `"kg"` | Unit of `variant.weight`. Set `"g"` if you store grams, or a 500 g shirt is priced as 500 kg. |
| `dimension_unit` | `"mm" \| "cm" \| "m"` | `"cm"` | Unit of `variant.length` / `width` / `height`. |
| `default_package_weight_kg` | `number` | `0.5` | Weight sent when no item weights are known. |
| `send_cart_total` | `boolean` | `true` | Send the basket value as `totalPrice` so nShift price rules can evaluate. |
| `send_to_book_and_print` | `boolean` | `false` | Push partial shipments to your Book & Print platform. |
| `split_shipments` | `boolean` | `false` | Use nShift's split-shipment endpoints: one sub-shipment per Medusa shipping profile. See [Split shipments](#split-shipments). |
| `include_in_conversion_rate` | `boolean` | `true` | Count sessions towards nShift's conversion-rate metric. |
| `request_timeout_ms` | `number` | `15000` | Per-request timeout against the nShift API. |
| `options_cache_ttl_ms` | `number` | `30000` | How long a session and its options are reused for an unchanged cart. |
| `api_base_url` | `string` | `https://api.nshiftportal.com/checkout` | Override the nShift API host. |
| `auth_url` | `string` | `https://account.nshiftportal.com/idp/connect/token` | Override the nShift token endpoint. |

## Admin setup

1. **Settings > Locations & Shipping >** your location **> Shipping options > Create.**
2. Set **Price type** to **Calculated** and pick **nShift** as the provider.
3. Choose one of the listed delivery options. Each Medusa shipping option maps to exactly one nShift delivery option, stored in `shipping_option.data.option_id`.

If the dropdown is empty or errors, the message says why; most often `default_country` / `default_postal_code` is missing or no options exist for that country.

## Storefront

The plugin adds no routes; the storefront uses Medusa's built-in store routes. Everything needed to render an option is on `shipping_option.calculated_price.nshift`.

```ts
// 1. Get priced options: listCartOptions, or calculate() for one calculated option.
const { shipping_options } = await sdk.store.fulfillment.listCartOptions({
  cart_id: cart.id,
})
const { shipping_option } = await sdk.store.fulfillment.calculate(soId, {
  cart_id: cart.id,
  data: { preselected_store_id: storeId }, // optional; addons here are added to the price
})

// 2. Skip unavailable options (no calculated_amount), render the rest.
const nshift = shipping_option.calculated_price?.nshift
// nshift.pickup_points, nshift.time_slots, nshift.addons, nshift.fields, ...

// 3. Add one method per shipping profile, sending the nShift ids back.
await sdk.store.cart.addShippingMethod(cart.id, [
  {
    option_id: shipping_option.id, // the Medusa shipping option
    data: {
      session_id: nshift.session_id,
      sub_shipment_id: nshift.sub_shipment_id, // split mode only
      pickup_point_id: "K384", // required if nshift.no_default_pickup_point
      time_slot_id: "slot-1",
      addons: [{ addon_id: "948058" }],
      fields: [{ field_id: "DOORCODE", value: "1234" }],
      preselected_store_id: storeId, // same value as in step 1
    },
  },
])
```

Method `data` keys (snake_case, or the nShift widget's camelCase such as `sessionId`):

| Key | Description |
| --- | --- |
| `session_id` | `calculated_price.nshift.session_id`; reused so the customer gets the options they were shown. |
| `sub_shipment_id` | `calculated_price.nshift.sub_shipment_id`. Required in split mode, otherwise a new session is created. |
| `preselected_store_id` | Only show this store as a custom pickup point when options are re-fetched. |
| `pickup_point_id` | A `pickupPointId` from the option's pickup points. |
| `time_slot_id` | A `timeSlotId` from the option's time slots. |
| `addons` | `[{ addon_id, fields?: [{ field_id, value }] }]`. |
| `addon_ids` | Shorthand: `["948058"]`. |
| `fields` | `[{ field_id, value }]` or a `{ FIELDID: value }` map. |

- Pickup point, time slot and addon are validated against the option; an unknown one is rejected with `400`. Addon prices are added to the shipping price.
- Other keys in `data` are kept as-is.
- `calculated_price.nshift` is snake_case; nShift's nested objects (pickup points, time slots, addons, fields, badges, delivery time) are passed through unchanged in nShift's camelCase. `price` is the base price, `calculated_amount` = `price` + `addons_price`.
- An unavailable option has no `calculated_amount` and no `nshift` block.
- The block reaches anonymous storefronts. It holds no credentials; the pickup-point and time-slot tokens in it are the ones nShift's own widget receives and grant no account access.
- This relies on Medusa passing calculatePrice's result through as `calculated_price`, which Medusa's types don't document. Verified on 2.19.0; re-check when upgrading.
- Anonymous callers supply `session_id`, so a session this process issued for a different cart is ignored and the cart gets its own.

Stored on the shipping method: `session_id`, `option_id`, `carrier_id`, `carrier_name`, `carrier_product_id`, `carrier_product_name`, `price`, `currency_code`, `delivery_time`, plus when selected `pickup_point_id`/`pickup_point`, `time_slot_id`/`time_slot`, `addons`, `fields`, and `sub_shipment_id` in split mode. After fulfillment, `fulfillment.data` adds `nshift_shipment_id`, `nshift_session_id`, `nshift_order_id`, `nshift_carrier`, `nshift_carrier_product` (and `nshift_sub_shipment_id` for split bookings).

## Split shipments

Set `split_shipments: true` (`NSHIFT_SPLIT_SHIPMENTS=true`) to give each Medusa shipping profile in the cart its own one-sub-shipment nShift split session. Needs no nShift portal setting, one Medusa shipping profile per part of the order, and Medusa >= 2.16 for multi-method `addShippingMethod`. Only split when parts of the order genuinely need different delivery options, not for warehouse packaging reasons.

- A session is reused in split mode only if the method data carries a `sub_shipment_id`; otherwise a new one is created.
- At fulfillment the stored ids decide the endpoint: with `sub_shipment_id` it books through the split endpoint, without it through the regular one, whatever the current setting.

## Fulfillment & errors

- `calculatePrice` never throws: the option is reported unavailable (no `calculated_amount`) when the cart has no country/postal code yet, nShift doesn't return the option or returns it without a price, nShift is unreachable or errors, or the shipping option has no nShift delivery option. Each case is logged with the nShift status and issues. On Medusa 2.19.0 an unavailable method is removed from the cart on refresh and an explicit selection gets `400 ... do not have a price`; test this on older versions.
- Startup throws if `client_id`, `client_secret` or `connection_id` is missing.
- Admin option list returns `400` for a missing `default_country` / `default_postal_code` or an nShift failure.
- `400` when selecting an option nShift no longer offers, an unknown pickup point/time slot/addon, a missing required pickup point, a method without `option_id`, or an order address nShift can't ship to.
- Fulfilling a method without `session_id`, or one nShift rejects with `400`, `404` or `410`: a new session is created, the selection is re-checked and the shipment is booked once more (`400` if no longer offered). `fulfillment.data.nshift_session_id` holds the new session; if the price changed, the booking still goes ahead with a warning and `nshift_rebooked_price` and `nshift_price_drift` (new minus stored) are added.
- A timeout, `5xx` or other `4xx` is returned without retry. **After a timeout or 5xx, check in nShift whether the shipment already exists before retrying**, or the order may get two; delete the extra one.
- A failed nShift delete on cancellation is logged; the cancellation still succeeds.

## Limitations

- No single split session holding all sub-shipments of a cart (e.g. for the nShift widget), and no sub-shipment assignment other than by shipping profile.
- A session replaced during pricing is only stored on the method when the storefront calls `addShippingMethod` again (fulfillment recovers by rebooking).
- `sendersOverride` / `mainSenderOverride` on split sub-shipments, Own Pickup Locations API management, and return shipments (`createReturnFulfillment`) are not implemented.
- No labels or tracking numbers: booking and printing happen in Book & Print, so `createFulfillment` returns no `labels`.
- Klarna badges and delivery types are not surfaced; badges and certifications appear in `calculated_price.nshift` but aren't stored on the shipping method.

## Changelog

### 0.1.7
- Pickup points, time slots and pickup time slots exposed to storefronts via `shipping_option.calculated_price.nshift` on Medusa's built-in store routes.
- Opt-in split shipments (`split_shipments` / `NSHIFT_SPLIT_SHIPMENTS`): one nShift sub-shipment per Medusa shipping profile.
- Storefront-pinned sessions (`session_id`, `sub_shipment_id`, `preselected_store_id`), updated when the cart changes.
- Fulfillments recover from expired or missing nShift sessions and record price drift.

Config changes (only needed for split orders; everything else is unchanged):

```env
# .env
NSHIFT_SPLIT_SHIPMENTS=false
```

```ts
// medusa-config.ts → nShift provider options
split_shipments: process.env.NSHIFT_SPLIT_SHIPMENTS === "true",
```

### 0.1.6
- Package keywords updated.

### 0.1.5
- Fixed delivery option fetching and pricing.

### 0.1.4
- Fixed package exports.

## License

MIT
