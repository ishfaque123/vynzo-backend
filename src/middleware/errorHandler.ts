import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/ApiResponse';

export class ApiError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    return sendError(res, err.statusCode, err.code, err.message);
  }

  // Unexpected error — never leak internal details to the client
  console.error(err);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong.');
}
