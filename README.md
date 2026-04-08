# medusa-nshift-plugin

nShift Checkout fulfillment provider plugin for [Medusa V2](https://medusajs.com).

Integrates [nShift Checkout API](https://developers.nshiftone.com/checkout/getting-started) as a fulfillment provider, enabling dynamic delivery options and pricing from nShift during checkout.

## Features

- **Dynamic delivery options** — fetches available shipping options from nShift Checkout API
- **Calculated pricing** — real-time shipping prices based on receiver address, packages, and carrier configuration
- **Partial shipments** — creates partial shipments in nShift when orders are fulfilled
- **Cancellation support** — deletes partial shipments in nShift when fulfillments are cancelled
- **OAuth2 token management** — automatically manages nShift API authentication with token caching

## Installation

```bash
# yarn
yarn add medusa-nshift-plugin

# local development with yalc
yalc add medusa-nshift-plugin
```

## Configuration

### Environment Variables

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

### medusa-config.ts

```ts
module.exports = defineConfig({
  // ...
  plugins: [
    {
      resolve: "medusa-nshift-plugin",
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
            resolve: "medusa-nshift-plugin/providers/nshift",
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

## Development

```bash
# Install dependencies
yarn install

# Build the plugin
yarn medusa plugin:build

# Watch mode
npm yarn medusa plugin:develop

# Publish locally with yalc
yalc publish
```

## What's included for now
- Core Nshift functionality as a delivery method/fulfilment method
- Communication between Medusa <> Nshift 
- Automatic creation of shipment in the Nshift Portal
- Full order cycle

## Soft limitations
Currently missing these features, however those are simple parameters passed when creating a partial shipment

- Addons (dangerous goods etc)
- Delivery date and time selection
- Pickup points (agents)
- Time slots
- Return badges and certificates to frontend (mirror response from Nshift)

**Example:**
```json
{
  "orderId": "",
  "sessionId": "",		
  "optionId": "",		// Returned from fetching delivery options, can be passed
  "pickupPointId": "", 	// Returned from fetching delivery options
  "timeSlotId": "",		// Returned from fetching delivery options
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