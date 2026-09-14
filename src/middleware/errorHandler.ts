import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
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

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) return sendError(res, err.statusCode, err.code, err.message);

  if (err instanceof ZodError) {
    const message = err.issues[0]?.message || 'Invalid input.';
    return sendError(res, 400, 'VALIDATION_ERROR', message);
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 413, 'FILE_TOO_LARGE', 'Uploaded file is too large.');
    return sendError(res, 400, 'UPLOAD_ERROR', err.message || 'File upload failed.');
  }

  if (err instanceof Error && (err.message.includes('Only video files') || err.message.includes('Only image files') || err.message.includes('Only images or audio files'))) {
    return sendError(res, 400, 'INVALID_FILE_TYPE', err.message);
  }

  console.error(err);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong.');
}
