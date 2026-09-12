import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { listDevices, revokeDevice, revokeOtherDevices } from '../services/deviceService';
import { getDeviceSession } from '../services/deviceSessionService';

export async function getDevicesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const current = await getDeviceSession(req.cookies?.vynzo_device);
    const devices = await listDevices(req.user!.id, current?.id ?? null);
    sendSuccess(res, { devices });
  } catch (err) {
    next(err);
  }
}

export async function revokeDeviceHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await revokeDevice(req.user!.id, req.params.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function revokeOtherDevicesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const current = await getDeviceSession(req.cookies?.vynzo_device);
    const result = await revokeOtherDevices(req.user!.id, current?.id ?? null);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
