import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { sendSuccess } from '../utils/ApiResponse';
import { PAYFAST_FRONTEND_RESULT_PATH } from '../config/payfast';
import { createBlueTickPayment, handlePayFastResult, normalizeResultParams } from '../services/payfastService';

// User-facing handler (authenticated, normal origin checks apply):
// creates the pending payment and returns the checkout form data.
export async function createBlueTickPaymentHandler(req: Request, res: Response, next: NextFunction) {
  try {
    // The PayFast callback URLs must point at this backend's public
    // origin; behind the proxy, req.protocol/req.host carry it.
    const publicBaseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await createBlueTickPayment(req.user!.id, publicBaseUrl);
    sendSuccess(res, result, 201);
  } catch (err) { next(err); }
}

// Server-to-server callback (CHECKOUT_URL / IPN). Mounted before the
// origin check (see app.ts): PayFast's servers do not send our
// frontend's Origin, and authenticity comes from the validation_hash
// verified in the service — not from the transport. Always answer
// 200 so the gateway does not retry a report we have recorded.
export async function payfastCallbackHandler(req: Request, res: Response) {
  try {
    const params = normalizeResultParams({ ...(req.query as Record<string, unknown>), ...(req.body ?? {}) });
    const { outcome } = await handlePayFastResult(params, 'ipn');
    console.log('[payfast] ipn processed', { basketId: params.basketId, errCode: params.errCode, outcome });
  } catch (err) {
    console.error('[payfast] ipn handler error', err);
  }
  return res.status(200).json({ success: true });
}

// Browser returns (SUCCESS_URL / FAILURE_URL). These run the SAME
// verified handling as the IPN — landing here alone grants nothing;
// the hash and err_code decide. Afterwards the browser is sent back
// to the frontend verification page with a result flag.
function returnRedirect(res: Response, ok: boolean) {
  const flag = ok ? 'success' : 'failed';
  return res.redirect(302, `${env.frontendUrl}${PAYFAST_FRONTEND_RESULT_PATH}?payfast=${flag}`);
}

export async function payfastSuccessReturnHandler(req: Request, res: Response) {
  let ok = false;
  try {
    const params = normalizeResultParams({ ...(req.query as Record<string, unknown>), ...(req.body ?? {}) });
    // A success return may arrive with no parameters at all (the IPN
    // is then the only report); with parameters it must verify.
    if (params.basketId) {
      const { outcome } = await handlePayFastResult(params, 'return');
      ok = outcome === 'paid' || outcome === 'already_paid';
    }
  } catch (err) {
    console.error('[payfast] success return handler error', err);
  }
  return returnRedirect(res, ok);
}

export async function payfastFailureReturnHandler(req: Request, res: Response) {
  try {
    const params = normalizeResultParams({ ...(req.query as Record<string, unknown>), ...(req.body ?? {}) });
    if (params.basketId) {
      // Records the failure (verified reports only, inside the
      // service). A verified success is never downgraded by this
      // endpoint because fulfilled rows are terminal there.
      await handlePayFastResult(params, 'return');
    }
  } catch (err) {
    console.error('[payfast] failure return handler error', err);
  }
  return returnRedirect(res, false);
}
