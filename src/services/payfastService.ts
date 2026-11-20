import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { PayFastPaymentStatus, VerificationRequestStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { ApiError } from '../middleware/errorHandler';
import { normalizeCountry } from '../utils/country';
import { createNotification } from './notificationService';
import {
  BLUE_TICK_DURATION_DAYS, BLUE_TICK_PRICE_PKR, BLUE_TICK_PRODUCT, BLUE_TICK_TXN_DESC,
  PAYFAST_API_PATHS, PAYFAST_CALLBACK_PATHS, PAYFAST_COUNTRY_CODE, PAYFAST_CURRENCY_CODE,
  PAYFAST_PROCCODE, PAYFAST_TRAN_TYPE, PAYFAST_VERSION, payfastAmountString,
} from '../config/payfast';

// PayFast (Pakistan) hosted checkout — Blue Tick purchases.
//
// Flow (see config/payfast.ts):
//   createBlueTickPayment  -> pending payfast_payments row + access
//                             token + checkout form fields for the
//                             browser/WebView to auto-submit.
//   handlePayFastResult    -> the ONLY place a payment is fulfilled.
//                             Called by both the server callback (IPN)
//                             and the browser success/failure returns;
//                             a payment is fulfilled only when the
//                             validation_hash verifies AND err_code is
//                             "000". Processing is idempotent per
//                             basket_id.
//
// Blue Tick grant: the same user fields the admin verification flow
// sets (isVerified / verifiedAt / verifiedBy), plus verifiedUntil —
// the paid tick runs for BLUE_TICK_DURATION_DAYS and then expires.
// Every grant path sets verifiedUntil; no tick is permanent.

export function isPayFastConfigured(): boolean {
  return Boolean(env.payfastMerchantId && env.payfastSecuredKey);
}

function requirePayFastConfigured() {
  if (!isPayFastConfigured()) {
    throw new ApiError(503, 'PAYFAST_NOT_CONFIGURED', 'Online payment is not available right now. Please use the manual payment option.');
  }
}

// Unique per payment attempt; also stored as the row's basket_id and
// used to look the payment up when PayFast reports the result.
function generateBasketId(): string {
  const time = Date.now().toString(36).toUpperCase();
  const random = randomBytes(4).toString('hex').toUpperCase();
  return `BT-${time}-${random}`;
}

// PayFast expects ORDER_DATE as "YYYY-MM-DD HH:mm:ss".
function formatOrderDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// SIGNATURE field of the checkout form. The official hosted-checkout
// sample ships a placeholder random string; the widely used Laravel
// package computes md5(MERCHANT_ID:MERCHANT_NAME:TXNAMT:BASKET_ID).
// We send the deterministic md5 form — if PayFast's issued merchant
// document says otherwise, this one function is the only change.
function checkoutSignature(basketId: string, amountString: string): string {
  return createHash('md5')
    .update(`${env.payfastMerchantId}:${env.payfastMerchantName}:${amountString}:${basketId}`)
    .digest('hex');
}

// Step 1: access token (server-to-server). The SECURED_KEY is sent
// only here and never reaches the browser.
async function getAccessToken(basketId: string, amountString: string): Promise<string> {
  const body = new URLSearchParams({
    MERCHANT_ID: env.payfastMerchantId,
    SECURED_KEY: env.payfastSecuredKey,
    BASKET_ID: basketId,
    TXNAMT: amountString,
    CURRENCY_CODE: PAYFAST_CURRENCY_CODE,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let data: any;
  try {
    const res = await fetch(`${env.payfastBaseUrl}${PAYFAST_API_PATHS.getAccessToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`PayFast token request failed with HTTP ${res.status}`);
  } catch (err) {
    console.error('[payfast] GetAccessToken failed', err);
    throw new ApiError(502, 'PAYFAST_TOKEN_FAILED', 'Could not start the payment. Please try again.');
  } finally {
    clearTimeout(timeout);
  }

  const token = typeof data?.ACCESS_TOKEN === 'string' ? data.ACCESS_TOKEN : '';
  if (!token) {
    console.error('[payfast] GetAccessToken returned no ACCESS_TOKEN', data);
    throw new ApiError(502, 'PAYFAST_TOKEN_FAILED', 'Could not start the payment. Please try again.');
  }
  return token;
}

export interface PayFastCheckout {
  url: string;
  fields: Record<string, string>;
}

// Creates the pending payment row, fetches the access token and
// returns everything the client needs to auto-submit the checkout
// form to PayFast. publicBaseUrl is this backend's own public origin
// (from the incoming request) so the callback URLs are correct in
// both sandbox testing and production.
export async function createBlueTickPayment(userId: string, publicBaseUrl: string) {
  requirePayFastConfigured();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, phone: true, country: true, isVerified: true, verifiedUntil: true },
  });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  // Same Pakistan-only gate Boost uses: PayFast serves Pakistani
  // payment methods and settles in PKR (owner model: Pakistan first).
  if (normalizeCountry(user.country) !== PAYFAST_COUNTRY_CODE) {
    throw new ApiError(403, 'PAYFAST_COUNTRY_NOT_ELIGIBLE', 'PayFast payment is available for users in Pakistan only.');
  }

  const now = new Date();
  const tickStillActive = user.isVerified && (user.verifiedUntil === null || user.verifiedUntil.getTime() > now.getTime());
  if (tickStillActive) {
    throw new ApiError(409, 'BLUE_TICK_ALREADY_ACTIVE', 'Your Blue Tick is already active.');
  }

  // PayFast's checkout page requires both customer fields.
  const customerEmail = (user.email || '').trim();
  const customerMobile = (user.phone || '').trim();
  if (!customerEmail || !customerMobile) {
    throw new ApiError(400, 'PAYFAST_CUSTOMER_DETAILS_MISSING', 'Add your email address and mobile number to your profile before paying online.');
  }

  const basketId = generateBasketId();
  const amountString = payfastAmountString(BLUE_TICK_PRICE_PKR);

  const payment = await prisma.payFastPayment.create({
    data: {
      userId: user.id,
      basketId,
      product: BLUE_TICK_PRODUCT,
      amountPkr: BLUE_TICK_PRICE_PKR,
      currencyCode: PAYFAST_CURRENCY_CODE,
      status: PayFastPaymentStatus.pending,
    },
    select: { id: true, basketId: true, amountPkr: true, status: true, createdAt: true },
  });

  let token: string;
  try {
    token = await getAccessToken(basketId, amountString);
  } catch (err) {
    // The checkout can never start without a token; close the row out
    // as failed instead of leaving a pending row that looks payable.
    await prisma.payFastPayment.update({
      where: { id: payment.id },
      data: { status: PayFastPaymentStatus.failed, errMsg: 'Access token request failed.' },
    }).catch(() => {});
    throw err;
  }

  const base = publicBaseUrl.replace(/\/+$/, '');
  const checkout: PayFastCheckout = {
    url: `${env.payfastBaseUrl}${PAYFAST_API_PATHS.postTransaction}`,
    fields: {
      MERCHANT_ID: env.payfastMerchantId,
      MERCHANT_NAME: env.payfastMerchantName,
      TOKEN: token,
      BASKET_ID: basketId,
      TXNAMT: amountString,
      CURRENCY_CODE: PAYFAST_CURRENCY_CODE,
      ORDER_DATE: formatOrderDate(now),
      SUCCESS_URL: `${base}${PAYFAST_CALLBACK_PATHS.success}`,
      FAILURE_URL: `${base}${PAYFAST_CALLBACK_PATHS.failure}`,
      CHECKOUT_URL: `${base}${PAYFAST_CALLBACK_PATHS.checkout}`,
      CUSTOMER_EMAIL_ADDRESS: customerEmail,
      CUSTOMER_MOBILE_NO: customerMobile,
      TXNDESC: BLUE_TICK_TXN_DESC,
      PROCCODE: PAYFAST_PROCCODE,
      TRAN_TYPE: PAYFAST_TRAN_TYPE,
      VERSION: PAYFAST_VERSION,
      SIGNATURE: checkoutSignature(basketId, amountString),
    },
  };

  return { payment, checkout };
}

// Callback authenticity: SHA256 of
//   basket_id + "|" + SECURED_KEY + "|" + MERCHANT_ID + "|" + err_code
// compared against the validation_hash PayFast sent.
export function verifyValidationHash(basketId: string, errCode: string, validationHash: string): boolean {
  const expected = createHash('sha256')
    .update(`${basketId}|${env.payfastSecuredKey}|${env.payfastMerchantId}|${errCode}`)
    .digest('hex');
  const a = Buffer.from(expected.toLowerCase());
  const b = Buffer.from(String(validationHash || '').toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PayFastResultParams {
  basketId: string;
  errCode: string;
  errMsg: string;
  transactionId: string;
  validationHash: string;
  raw: Record<string, string>;
}

// Callback parameter casing varies between PayFast wrappers
// (basket_id vs BASKET_ID, and some echo the id as order_id), so read
// every known casing. The raw payload is kept for the payment row and
// for confirming the real casing on the first sandbox transactions.
export function normalizeResultParams(input: Record<string, unknown>): PayFastResultParams {
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (typeof value === 'string') raw[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') raw[key] = String(value);
  }
  const pick = (...keys: string[]) => {
    for (const key of keys) if (raw[key]) return raw[key];
    return '';
  };
  return {
    basketId: pick('basket_id', 'BASKET_ID', 'order_id', 'ORDER_ID'),
    errCode: pick('err_code', 'ERR_CODE'),
    errMsg: pick('err_msg', 'ERR_MSG'),
    transactionId: pick('transaction_id', 'TRANSACTION_ID'),
    validationHash: pick('validation_hash', 'VALIDATION_HASH'),
    raw,
  };
}

export type PayFastResultOutcome =
  | 'paid'           // verified success, Blue Tick activated now
  | 'already_paid'   // verified success, but this basket was already fulfilled
  | 'failed'         // verified non-success result, marked failed
  | 'pending'        // err_code 001: gateway still processing, row left pending
  | 'invalid_hash'   // validation_hash did not verify — nothing was fulfilled
  | 'unknown_basket'; // no payment row for this basket_id

// Handles one result report (server IPN or browser return). Safe to
// call more than once with the same result: the pending -> paid /
// pending -> failed transition is guarded, so fulfilment runs once.
export async function handlePayFastResult(params: PayFastResultParams, source: 'ipn' | 'return'): Promise<{ outcome: PayFastResultOutcome; userId?: string }> {
  if (!params.basketId) return { outcome: 'unknown_basket' };

  const payment = await prisma.payFastPayment.findUnique({
    where: { basketId: params.basketId },
    select: { id: true, userId: true, status: true, amountPkr: true },
  });
  if (!payment) {
    console.error('[payfast] result for unknown basket', { basketId: params.basketId, source });
    return { outcome: 'unknown_basket' };
  }

  // Idempotency: a fulfilled payment stays fulfilled whatever arrives
  // later; a failed one is only reopened by a verified success.
  if (payment.status === PayFastPaymentStatus.paid) {
    return { outcome: 'already_paid', userId: payment.userId };
  }

  const hashValid = verifyValidationHash(params.basketId, params.errCode, params.validationHash);
  if (!hashValid) {
    // Never fulfil on an unverifiable report. Keep the raw payload on
    // the row for investigation and leave the status untouched.
    console.error('[payfast] validation_hash mismatch', { basketId: params.basketId, errCode: params.errCode, source });
    await prisma.payFastPayment.update({
      where: { id: payment.id },
      data: { rawCallback: params.raw, errCode: params.errCode || null, errMsg: params.errMsg || null },
    }).catch(() => {});
    return { outcome: 'invalid_hash', userId: payment.userId };
  }

  if (params.errCode === '001') {
    await prisma.payFastPayment.update({
      where: { id: payment.id },
      data: { rawCallback: params.raw, errCode: params.errCode, errMsg: params.errMsg || null, transactionId: params.transactionId || null },
    }).catch(() => {});
    return { outcome: 'pending', userId: payment.userId };
  }

  if (params.errCode !== '000') {
    await prisma.payFastPayment.updateMany({
      where: { id: payment.id, status: PayFastPaymentStatus.pending },
      data: {
        status: PayFastPaymentStatus.failed,
        rawCallback: params.raw,
        errCode: params.errCode || null,
        errMsg: params.errMsg || null,
        transactionId: params.transactionId || null,
      },
    });
    return { outcome: 'failed', userId: payment.userId };
  }

  // Verified success — fulfil exactly once.
  const now = new Date();
  const activated = await prisma.$transaction(async (tx) => {
    const result = await tx.payFastPayment.updateMany({
      where: { id: payment.id, status: PayFastPaymentStatus.pending },
      data: {
        status: PayFastPaymentStatus.paid,
        rawCallback: params.raw,
        errCode: params.errCode,
        errMsg: params.errMsg || null,
        transactionId: params.transactionId || null,
        paidAt: now,
      },
    });
    if (result.count !== 1) return false; // a parallel report beat us to it

    // Owner rule (2026-11-21): a tick never runs longer than
    // BLUE_TICK_DURATION_DAYS, so a renewal restarts the period from
    // payment instead of stacking on the remaining time.
    const verifiedUntil = new Date(now.getTime() + BLUE_TICK_DURATION_DAYS * 24 * 60 * 60 * 1000);

    await tx.user.update({
      where: { id: payment.userId },
      data: { isVerified: true, verifiedAt: now, verifiedBy: 'payfast', verifiedUntil },
    });

    // Keep the admin verification queue consistent, mirroring the
    // admin direct-grant path: a paid tick closes any pending request.
    await tx.verificationRequest.updateMany({
      where: { userId: payment.userId, status: VerificationRequestStatus.pending },
      data: { status: VerificationRequestStatus.approved, adminNote: 'Paid via PayFast.', reviewedAt: now },
    });

    return true;
  });

  if (!activated) return { outcome: 'already_paid', userId: payment.userId };

  // Same notification the admin approval sends, and like the boost
  // review it is sent AFTER the transaction commits so a notification
  // failure can never roll back the grant.
  await createNotification({ userId: payment.userId, type: 'verification_approved' })
    .catch((err) => console.error('[payfast] verification notification failed', err));

  return { outcome: 'paid', userId: payment.userId };
}
