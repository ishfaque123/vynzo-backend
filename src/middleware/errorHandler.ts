import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
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

  if (err instanceof ZodError) {
    const message = err.issues[0]?.message || 'Invalid input.';
    return sendError(res, 400, 'VALIDATION_ERROR', message);
  }

  console.error(err);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong.');
}
