import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { getSiteSettings } from '../services/settingsService';

export async function getSeoSettingsHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const settings = await getSiteSettings();
    sendSuccess(res, {
      seoTitle: settings.seoTitle,
      seoDescription: settings.seoDescription,
      seoKeywords: settings.seoKeywords,
    });
  } catch (err) { next(err); }
}
