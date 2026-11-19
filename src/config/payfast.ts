// PayFast (Pakistan) hosted-checkout configuration for the paid Blue
// Tick. Credentials come from the environment only (see config/env.ts)
// and are never hardcoded here. The flow is the 2-step hosted checkout:
//   1. POST {PAYFAST_BASE_URL}/Ecommerce/api/Transaction/GetAccessToken
//      (server-to-server, the only call that carries the SECURED_KEY)
//   2. The customer's browser/WebView auto-submits a form to
//      {PAYFAST_BASE_URL}/Ecommerce/api/Transaction/PostTransaction
//      and pays on PayFast's own page.
// Fulfilment happens only in the verified callback handler
// (services/payfastService.ts) — never on the browser redirect alone.

export const PAYFAST_API_PATHS = {
  getAccessToken: '/Ecommerce/api/Transaction/GetAccessToken',
  postTransaction: '/Ecommerce/api/Transaction/PostTransaction',
} as const;

// Public callback paths on THIS backend. PayFast's servers call
// checkoutPath (the IPN); the customer's browser is redirected to the
// success/failure return paths after paying. All three are handled by
// routes/payfastCallbackRoutes.ts, mounted before the origin check in
// app.ts because gateway calls do not carry our frontend's Origin.
export const PAYFAST_CALLBACK_PATHS = {
  checkout: '/api/payfast/callback',
  success: '/api/payfast/return/success',
  failure: '/api/payfast/return/failure',
} as const;

// Where the browser is sent after a return endpoint has verified the
// result (relative to env.frontendUrl).
export const PAYFAST_FRONTEND_RESULT_PATH = '/settings-menu/verification';

// Blue Tick product (owner model 2026-11-18: Rs 400 for 1 month,
// Pakistan first). The amount is fixed server-side; the client never
// sends an amount.
export const BLUE_TICK_PRODUCT = 'blue_tick';
export const BLUE_TICK_PRICE_PKR = 400;
export const BLUE_TICK_DURATION_DAYS = 30;
export const BLUE_TICK_TXN_DESC = 'Frianzo Blue Tick - 1 month';

// PayFast only serves Pakistani payment methods and settles in PKR, so
// purchases are limited to accounts whose own country is Pakistan —
// the same gate Boost uses (config/boost.ts BOOST_COUNTRY_CODE).
export const PAYFAST_COUNTRY_CODE = 'PK';

export const PAYFAST_CURRENCY_CODE = 'PKR';
export const PAYFAST_PROCCODE = '00';
export const PAYFAST_TRAN_TYPE = 'ECOMM_PURCHASE';
export const PAYFAST_VERSION = 'MERCHANTCART-0.1';

// PayFast expects the amount as a plain decimal string, identical in
// the token request and the checkout form (e.g. "400.00").
export function payfastAmountString(amountPkr: number): string {
  return amountPkr.toFixed(2);
}
