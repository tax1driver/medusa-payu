<p align="center">
  <a href="https://www.medusajs.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://user-images.githubusercontent.com/59018053/229103275-b5e482bb-4601-46e6-8142-244f531cebdb.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    <img alt="Medusa logo" src="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    </picture>
  </a>
</p>
<h2 align="center">
  Medusa PayU Payment Provider
</h2>

<h5 align="center">
  <a href="https://docs.medusajs.com">MedusaJS</a> |
  <a href="https://www.payu.com">PayU Homepage</a> |
  <a href="https://developers.payu.com">PayU Docs</a> |
  <a href="https://www.npmjs.com/package/@tax1driver/medusa-payu">npm</a>
</h5>

## Compatibility

This plugin is compatible with Medusa v2.4.0+.

## Overview

This plugin provides PayU payment integration for Medusa commerce platform.

## Installation

```bash
npm install @tax1driver/medusa-payu
# or
yarn add @tax1driver/medusa-payu
```

## Configuration

Add the payment provider configuration to your `medusa-config.ts`:

```typescript
modules: [
  // ... other modules ...
  {
    resolve: "@medusajs/medusa/payment",
    options: {
      providers: [
        {
          resolve: '@tax1driver/medusa-payu/providers/payu',
          options: {
            clientId: process.env.PAYU_CLIENT_ID,
            clientSecret: process.env.PAYU_CLIENT_SECRET,
            merchantPosId: process.env.PAYU_MERCHANT_POS_ID,
            secondKey: process.env.PAYU_SECOND_KEY,
            sandbox: process.env.PAYU_SANDBOX === "true",
            returnUrl: process.env.PAYU_RETURN_URL,
            
            // By default, this should be your backend's base URL + /hooks/payment/payu (e.g. https://example.com/hooks/payment/payu)
            callbackUrl: process.env.PAYU_CALLBACK_URL || `${process.env.APP_BASE_URL}/hooks/payment/payu`,
            
            title: "Payment for order", // Optional
            refundDescription: "Refund", // Optional
          },
        },
      ],
    }
  }
]
```

## Usage

### Overview

Once configured, PayU will be available as a payment provider in your Medusa store. The plugin integrates seamlessly with Medusa's payment workflow to handle the complete payment lifecycle.

### Required Data
The following data is required from your checkout flow and needs to be provided in the `initiatePaymentSession` call in order to create a PayU transaction:

```ts
const payuData = {
  customer_ip: string;
  email: string;
}
```


### Payment Flow

When a customer selects PayU as their payment method during checkout, the plugin creates a new transaction with PayU and returns a payment URL.

1. **Redirect**: Redirect the customer to the provided PayU payment URL to let them complete the payment on PayU's payment page.
2. **Payment Processing**: After completing or canceling the payment, the customer is redirected back to your store via the configured values.
   
3. **Webhook Notification**: PayU sends a webhook notification to your configured `callbackUrl` endpoint to confirm the payment status. The plugin automatically validates and processes these webhooks.

4. **Order Completion**: Based on the webhook data, Medusa updates the payment and order status accordingly.


### Webhook Configuration

The webhook endpoint is automatically registered at `/hooks/payment/payu`. Ensure that:

- Your `callbackUrl` points to this endpoint (e.g., `https://yourdomain.com/hooks/payment/payu`)
- The endpoint is publicly accessible
- Your firewall allows incoming requests from PayU's servers

### Refunds

Refunds can be processed through Medusa's admin panel or API. The plugin will:

- Create a refund request with PayU
- Process partial or full refunds
- Update the order status in Medusa accordingly

You can customize the refund description using the `refundDescription` option in the plugin configuration.
