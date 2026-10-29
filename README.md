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

- Medusa `>= 2.13.3` (the peer range is `^2.13.3`). Adding several shipping methods in one `addShippingMethod` call, used for one-method-per-shipping-profile carts below, needs Medusa `>= 2.16.0`.
- The Medusa-only storefront flow (reading `calculated_price.nshift` from Medusa's own store routes) has only been verified on Medusa **2.19.0**. The peer range allows older 2.x versions; check the pass-through described under [`calculated_price.nshift`](#calculated_pricenshift) before relying on it there.
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
              // Split orders: one nShift sub-shipment per shipping profile
              split_shipments: process.env.NSHIFT_SPLIT_SHIPMENTS === "true",
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
# Split orders (split shipments). Set to true to use nShift's split-shipment
# endpoints; leave false for one regular session per shipping profile.
NSHIFT_SPLIT_SHIPMENTS=false
```

`NSHIFT_SPLIT_SHIPMENTS` only takes effect if `medusa-config.ts` maps it to `split_shipments` as shown above. Split orders need no other variables or nShift portal setting: nShift enables split shipment purely by which endpoints are called. They do need one Medusa shipping profile per part of the order, and Medusa 2.16+ so the storefront can add one shipping method per profile.

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
| `split_shipments` | `boolean` | `false` | Use nShift's split-shipment endpoints: one sub-shipment per Medusa shipping profile. See [Pickup points, time slots & split shipments](#pickup-points-time-slots--split-shipments). |
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

The storefront only uses Medusa's built-in store routes; the plugin adds no routes of its own. Price calculated options with `POST /store/shipping-options/:id/calculate` (on Medusa 2.19.0, `GET /store/shipping-options` already returns them priced too), then add the method to the cart. See [Pickup points, time slots & split shipments](#pickup-points-time-slots--split-shipments) for the nShift details each price carries.

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
const selectable = priced.filter(
  (option) => option.calculated_price?.calculated_amount !== undefined
)

// 4. Add the customer's choice to the cart, pinning the session it was priced in.
await sdk.store.cart.addShippingMethod(cart.id, {
  option_id: selected.id,
  data: {
    session_id: selected.calculated_price.nshift.session_id,
    sub_shipment_id: selected.calculated_price.nshift.sub_shipment_id, // split mode only
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
| `session_id` | `sessionId` | `calculated_price.nshift.session_id`. Reused so the customer gets the options they were shown. |
| `sub_shipment_id` | `subShipmentId` | `calculated_price.nshift.sub_shipment_id`. Required in split mode, otherwise a new session is created. |
| `preselected_store_id` | `preselectedStoreId` | Only show this store as a custom pickup point when nShift options are re-fetched. |
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

In split mode it also carries `sub_shipment_id`.

After fulfillment, `fulfillment.data` additionally carries `nshift_shipment_id`, `nshift_session_id`, `nshift_order_id`, `nshift_carrier` and `nshift_carrier_product`, plus `nshift_sub_shipment_id` for shipments booked through the split endpoints.

If the shipment had to be booked in a new session (see [Behaviour and error handling](#behaviour-and-error-handling)) and nShift now charges a different price for the option and its addons than the `price` stored on the shipping method, the booking still goes ahead, a warning is logged, and `fulfillment.data` also carries `nshift_rebooked_price` (the new price) and `nshift_price_drift` (new minus stored).

## Pickup points, time slots & split shipments

There is no custom store route. Everything a storefront needs to render an nShift option comes back on the shipping option's price, from Medusa's own routes:

| SDK call | Route |
| --- | --- |
| `sdk.store.fulfillment.listCartOptions({ cart_id })` | `GET /store/shipping-options` |
| `sdk.store.fulfillment.calculate(id, { cart_id, data })` | `POST /store/shipping-options/:id/calculate` |
| `sdk.store.cart.addShippingMethod(cart_id, …)` | `POST /store/carts/:id/shipping-methods` |

### `calculated_price.nshift`

When an option is available, the provider's `calculatePrice` returns the price plus an `nshift` block. Medusa passes the provider's whole `calculatePrice` result through as `shipping_option.calculated_price`, on both the list and the calculate route. This was checked against Medusa 2.19.0 (`list-shipping-options-for-cart-with-pricing` and the `calculate` route). Medusa's `CalculatedShippingOptionPrice` type only documents `calculated_amount` and `is_calculated_price_tax_inclusive`, so the extra key depends on that pass-through. A unit test makes sure the provider keeps returning the block; re-check the pass-through when you upgrade Medusa.

```json
{
  "calculated_amount": 6.4,
  "is_calculated_price_tax_inclusive": true,
  "nshift": {
    "session_id": "77933415-a756-4eab-821a-98fb6fc9aa75",
    "sub_shipment_id": "77933415-a756-4eab-821a-98fb6fc9aa75",
    "option_id": "834827b2-abc2-4e05-8520-7707c1d2c4d8",
    "name": "Posti pickup point",
    "carrier_name": "Posti",
    "carrier_product_name": "Postipaketti",
    "price": 5.9,
    "addons_price": 0.5,
    "currency_code": "EUR",
    "delivery_time": { "earliestDays": 1, "latestDays": 2, "description": "1-2 days" },
    "pickup_points": [{ "pickupPointId": "K384", "name": "K-Market Kamppi", "distance": 450 }],
    "no_default_pickup_point": true,
    "time_slots": [],
    "pickup_time_slots": [],
    "addons": [{ "addonId": "948058", "title": "SMS notification", "price": 0.5 }],
    "fields": [],
    "texts": ["Delivered to the pickup point you choose"],
    "logo_url": "https://…/posti.png",
    "badges": [],
    "certifications": []
  }
}
```

- The envelope is snake_case. nShift's nested objects (pickup points with opening hours, time slots, pickup time slots, addons, fields, badges, certifications, delivery time) are passed through unchanged, in nShift's camelCase.
- `sub_shipment_id` is only present in split mode. `price` is the base price; `addons_price` is the sum of the addons sent in `data.addons`, and `calculated_amount` is the two added together.
- An unavailable option has no `calculated_amount` and no `nshift` block.
- The block reaches anonymous storefronts. It never holds provider credentials, only what nShift's own browser widget receives. A unit test pins its exact set of top-level keys.
- Pickup points and time slots are passed through with nShift's own widget fields, including `allocateToken`, `pickupLockerToken` and `externalPickupLockerToken` on pickup points and `timeSlotToken` / `externalTimeSlotToken` on time slots. These are the tokens nShift's checkout widget receives for the customer's selection; they are not API credentials and grant no access to your nShift account.

### Storefront flow

```ts
// 1. List the cart's options. One shipping profile = one group of options.
const { shipping_options } = await sdk.store.fulfillment.listCartOptions({
  cart_id: cart.id,
})

// 2. Price each nShift option. `data` is optional: pass the addons the customer
//    ticked to get their price included, or `preselected_store_id`.
const priced = await Promise.all(
  shipping_options
    .filter((option) => option.price_type === "calculated")
    .map(async (option) => {
      const { shipping_option } = await sdk.store.fulfillment.calculate(option.id, {
        cart_id: cart.id,
        data: { preselected_store_id: storeId },
      })
      return shipping_option
    })
)

// 3. Show only available options and render pickup points, slots and addons.
const selectable = priced.filter(
  (option) => option.calculated_price?.calculated_amount !== undefined
)
for (const option of selectable) {
  const nshift = option.calculated_price.nshift
  // nshift.pickup_points, nshift.time_slots, nshift.addons, nshift.fields, …
}

// 4. Add one method per shipping profile, sending the nShift ids back.
await sdk.store.cart.addShippingMethod(
  cart.id,
  Object.values(choiceByShippingProfile).map((choice) => {
    const nshift = choice.option.calculated_price.nshift
    return {
      option_id: choice.option.id, // the Medusa shipping option
      data: {
        session_id: nshift.session_id,
        sub_shipment_id: nshift.sub_shipment_id, // split mode only
        pickup_point_id: choice.pickupPointId, // required if nshift.no_default_pickup_point
        time_slot_id: choice.timeSlotId, // optional
        addons: choice.addons, // optional, [{ addon_id, fields? }]
        fields: choice.fields, // optional, [{ field_id, value }]
        preselected_store_id: storeId, // optional, same value as in step 2
      },
    }
  })
)
```

`data.option_id` is not needed: the nShift option comes from the Medusa shipping option's own `data.option_id`.

Sending an array to `addShippingMethod` needs Medusa 2.16 or later. The plugin's peer range (`^2.13.3`) also allows older versions; there, call `addShippingMethod` once per shipping profile.

The provider validates the pickup point, time slot and addons against the option, and stores the session (and sub-shipment) on the shipping method. When `session_id` / `sub_shipment_id` (and `preselected_store_id`) match what `calculatePrice` returned for the same cart, and the request reaches the same server process within `options_cache_ttl_ms`, the provider serves the selection from the options it already fetched, without calling nShift again. Otherwise the options are fetched again inside the pinned session. If the cart changed in the meantime (address or items), or changed and then changed back, the pinned session is first updated with nShift's `PUT` session endpoint, and options are then fetched inside it. If nShift no longer accepts the session, a new one is created.

The options cache, and the record of which context each session was last updated with, live in memory per process. With several Medusa instances behind a load balancer, or after a restart, a request that lands on a process that has not seen the session costs at most one extra session update and one options fetch; the result is the same.

`session_id` / `sub_shipment_id` come from anonymous storefront callers, so the provider remembers which cart each session it issued belongs to. A pinned session that this process issued for a different cart is ignored (with a warning in the log) and the cart gets its own session. A session the process does not know, for example one issued by another instance or before a restart, is accepted.

### Split shipments

Medusa prices and validates each shipping profile's options separately, with only that profile's items. In split mode each profile therefore gets **its own nShift split session with one sub-shipment**, and fulfilling a method books it through nShift's split-shipment endpoint. The provider does not create a single session that holds every sub-shipment of the cart, for example to drive the nShift checkout widget across all of them.

A pinned split session must be one this provider created (one sub-shipment). Pinned fetches and updates only send that one sub-shipment.

### `split_shipments`

nShift turns split shipment on purely by which endpoints are called; there is no account flag. nShift recommends building on the split endpoints from the start if the order may ever need to be split, because the regular endpoints cannot split. Only split when parts of the order genuinely need different delivery options (for example bulky goods), not for warehouse packaging reasons.

With `split_shipments: true`, each Medusa shipping profile in the cart becomes its own one-sub-shipment split session. The provider only reuses a session in split mode when the method data carries a `sub_shipment_id`, so a single-mode session id is replaced by a new session. At fulfillment the stored ids decide the endpoint, whatever the current setting: a method with a `sub_shipment_id` is booked through the split endpoint, one without it through the regular one.

## Behaviour and error handling

The provider never breaks a cart. `calculatePrice` reports an option as **unavailable** — no `calculated_amount` — instead of throwing, whenever:

- the cart has no country or postal code yet,
- nShift does not return the option for that address (wrong country route, weight over the limit, a price rule excluding it),
- nShift returns the option without a price,
- the nShift API is unreachable, times out or errors,
- the shipping option has no nShift delivery option attached.

On Medusa 2.19.0, a missing price means "not available in this context": `refreshCartShippingMethodsWorkflow` removes the shipping method, and an explicit selection is rejected with `400 … do not have a price`. Medusa's provider docs describe a missing `calculated_amount` more broadly as blocking the operation that triggered the calculation, and the peer range (`^2.13.3`) allows versions this was not checked against, so test it on your version. So changing the shipping country to one a carrier does not serve drops that method rather than failing the address update. Every case is logged with the nShift status and `issues[]` so you can see the reason in the server log.

Errors are raised where they are actionable instead:

| Situation | Result |
| --- | --- |
| Missing `client_id` / `client_secret` / `connection_id` | throws at startup |
| Admin option list without `default_country` / `default_postal_code` | `400` naming the missing option |
| Admin option list, nShift request fails | `400` including the nShift status and issues |
| Selecting an option nShift no longer offers | `400`, pick another method |
| Unknown pickup point, time slot or addon | `400` naming it |
| Option requires a pickup point and none was sent | `400` |
| Fulfilling a method without `option_id` | `400` |
| Fulfilling a method without `session_id`, or whose booking nShift rejects with `400`, `404` or `410` | a new session is created, the option (and pickup point / time slot) is checked, and the shipment is booked once more. `fulfillment.data.nshift_session_id` holds the new session; a price change is recorded as described under [What ends up on the shipping method](#what-ends-up-on-the-shipping-method). `400` if the selection is no longer offered |
| Booking times out, fails in transit, or nShift answers `5xx` (or another `4xx`, such as `422`) | the error is returned and nothing is retried; see the note below |
| Order address nShift cannot ship to | `400` |
| nShift refuses to delete a cancelled shipment | logged, cancellation still succeeds |

> **Possible double booking when a booking times out.** The provider only books a second time after nShift answered `400`, `404` or `410`, which means nShift refused the request and created no shipment. A timeout or a `5xx`, on the other hand, can arrive after nShift has already created the partial shipment. The provider then fails the fulfillment without retrying, but if staff simply create the fulfillment again, nShift may end up with two shipments for the order. Before retrying such a fulfillment, check in nShift whether the shipment for the order already exists, and delete the extra one if it does.

## Not covered yet

- One split session holding all of a cart's sub-shipments (for example for the nShift checkout widget); each shipping profile gets its own one-sub-shipment session.
- Writing a replacement session back to the shipping method: Medusa's cart refresh only updates the amount, so a session replaced during pricing is only stored when the storefront calls `addShippingMethod` again. Fulfillment recovers by booking in a new session.
- Assigning items to sub-shipments other than by shipping profile (e.g. per warehouse or per item).
- `sendersOverride` / `mainSenderOverride` on split sub-shipments.
- Return shipments — `createReturnFulfillment` is not implemented.
- Labels and tracking numbers: booking and printing still happen in your Book & Print platform, so `createFulfillment` returns no `labels`.
- Own Pickup Locations API management.
- Klarna badges and delivery types are read from nShift but not surfaced. Badges and certifications are returned in `calculated_price.nshift` but not stored on the shipping method.

## License

MIT
