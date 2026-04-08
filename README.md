# @solteq/@solteq/medusa-nshift-plugin

nShift Checkout fulfillment provider plugin for [Medusa V2](https://medusajs.com).

Integrates [nShift Checkout API](https://developers.nshiftone.com/checkout/getting-started) as a fulfillment provider, enabling dynamic delivery options and pricing from nShift during checkout.

## Features

- **Dynamic delivery options** — fetches available shipping options from nShift Checkout API
- **Calculated pricing** — real-time shipping prices based on receiver address, packages, and carrier configuration
- **Partial shipments** — creates partial shipments in nShift when orders are fulfilled
- **Cancellation support** — deletes partial shipments in nShift when fulfillments are cancelled
- **OAuth2 token management** — automatically manages nShift API authentication with token caching
- Pickup point selection
- Time slot selection

## Installation

```bash
# yarn (if published to npm):
yarn add @solteq/medusa-nshift-plugin

# local development with yalc:
cd /path/to/medusa-nshift-plugin

# if yalc is not installed:
yarn add --dev yalc

# if packages not installed, run (it will also build the plugin): 
yarn install

# if yalc works as it should, publish it locally:
yarn yalc publish

# go to main project:
cd /path/to/your-medusa-project

yarn medusa plugin:add @solteq/medusa-nshift-plugin

yarn install
```

## Local development
```bash
# after changes made in this plugin, run: 
yarn yalc publish

# it'll build and publish the plugin locally, then in the Medusa project run (assuming plugin already installed and working): 
yarn yalc update

# to pull the fresh package from yalc
yarn install 
# ➤ YN0013: │ A package was added to the project (+ 79.21 KiB).

# launch it
yarn run dev

# Nshift plugin is at its latest version
```

## Configuration

### Environment Variables

```env
NSHIFT_CLIENT_ID=your_client_id
NSHIFT_CLIENT_SECRET=your_client_secret # ‼️⚠️ See providers/nshift/client.ts, hard code it for debug purposes ⚠️‼️
NSHIFT_CONNECTION_ID=your_connection_id
NSHIFT_LANGUAGE_CODE=en
NSHIFT_LOCALE_ID=en-GB
NSHIFT_DEFAULT_COUNTRY=FI
NSHIFT_DEFAULT_POSTAL_CODE=00100
NSHIFT_SEND_TO_BOOK_AND_PRINT=false
```

### medusa-config.ts

```ts
module.exports = defineConfig({
  // ...
  plugins: [
    {
      resolve: "@solteq/medusa-nshift-plugin",
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
            resolve: "@solteq/medusa-nshift-plugin/providers/nshift",
            id: "nshift",
            options: {
              client_id: process.env.NSHIFT_CLIENT_ID,
              client_secret: process.env.NSHIFT_CLIENT_SECRET,
              connection_id: process.env.NSHIFT_CONNECTION_ID,
              language_code: process.env.NSHIFT_LANGUAGE_CODE || "en",
              locale_id: process.env.NSHIFT_LOCALE_ID || "en-GB",
              default_country: process.env.NSHIFT_DEFAULT_COUNTRY || "FI",
              default_postal_code: process.env.NSHIFT_DEFAULT_POSTAL_CODE || "00100",
              send_to_book_and_print: process.env.NSHIFT_SEND_TO_BOOK_AND_PRINT === "true",
            },
          },
        ],
      },
    },
  ],
})
```

## nShift Account Setup

1. Log in to [nShift Portal](https://www.nshiftportal.com/)
2. Go to **Settings → API Configuration → Clients** and create a Client ID/Secret with "Public checkout API" scope
3. Go to **Connections** and note your Connection ID
4. Configure your Checkout with carriers and delivery options

See the [nShift Checkout API documentation](https://developers.nshiftone.com/checkout/getting-started) for details.

## What's included for now
- Core Nshift functionality as a delivery method/fulfilment method
- Communication between Medusa <> Nshift 
- Automatic creation of shipment in the Nshift Portal
- Full order cycle

## Soft limitations
Currently missing these features, however those are simple parameters passed when creating a partial shipment

- Addons (dangerous goods etc)
- (??? need more research) Delivery date and time selection
- ~~Pickup points (agents)~~
- ~~Time slots~~
- Return badges and certificates to frontend (mirror response from Nshift)

**Example:**
```json
{
  "orderId": "",
  "sessionId": "",		
  "optionId": "",		
  "pickupPointId": "", 	
  "timeSlotId": "",		
  [...],
},
  "addons": [
    {
      "addonId": "",
      "fields": [
        {
          "fieldId": "MOBILE",
          "value": ""
        }
      ]
    }
  ],
}
```

## Frontend usage
```ts
// 1. Customer enters address, fetch nShift options
const { session_id, options } = await sdk.client.fetch(
  "/store/nshift/delivery-options",
  { method: "POST", body: { cart_id: cart.id } }
)

// 2. Render options[].pickupPoints[] and options[].deliveryTime from the response

// 3. Customer selects, add shipping method
await sdk.store.cart.addShippingMethod(cart.id, {
  option_id: medusaShippingOptionId,
  data: {
    session_id,
    option_id: selectedOption.optionId,
    pickup_point_id: selectedPickupPoint?.pickupPointId,
    time_slot_id: selectedTimeSlot?.timeSlotId,
  },
})
```