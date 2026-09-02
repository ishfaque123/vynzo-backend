import { Request, Response } from 'express';
import { sendError } from '../utils/ApiResponse';

export function notFound(req: Request, res: Response) {
  sendError(res, 404, 'ROUTE_NOT_FOUND', `No route found for ${req.method} ${req.originalUrl}`);
}
