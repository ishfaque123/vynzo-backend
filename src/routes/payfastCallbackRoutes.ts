import { Router, urlencoded } from 'express';
import {
  payfastCallbackHandler, payfastFailureReturnHandler, payfastSuccessReturnHandler,
} from '../controllers/payfastController';

const router = Router();

// Gateway-facing routes. PayFast posts results as
// application/x-www-form-urlencoded, which the app's global
// express.json() does not parse — hence the router-level parser.
// These routes are mounted in app.ts BEFORE verifyOrigin: gateway
// calls carry no Origin header from our frontend, and authenticity
// is proven by the validation_hash check in payfastService, not by
// the transport.
router.use(urlencoded({ extended: false }));

router.post('/callback', payfastCallbackHandler);
router.get('/return/success', payfastSuccessReturnHandler);
router.post('/return/success', payfastSuccessReturnHandler);
router.get('/return/failure', payfastFailureReturnHandler);
router.post('/return/failure', payfastFailureReturnHandler);

export default router;
