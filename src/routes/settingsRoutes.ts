import { Router } from 'express';
import { getSeoSettingsHandler } from '../controllers/settingsController';

const router = Router();
router.get('/seo', getSeoSettingsHandler);

export default router;
