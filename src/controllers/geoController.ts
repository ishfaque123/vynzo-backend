import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendSuccess } from '../utils/ApiResponse';
import { reverseGeocode } from '../services/geoService';

const reverseSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

export async function reverseGeocodeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { lat, lng } = reverseSchema.parse(req.query);
    const location = await reverseGeocode(lat, lng);
    sendSuccess(res, { location });
  } catch (err) { next(err); }
}
