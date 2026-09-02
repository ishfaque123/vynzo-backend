import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface VynzoTokenPayload {
  userId: string;
}

export function signToken(payload: VynzoTokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as SignOptions);
}

export function verifyToken(token: string): VynzoTokenPayload {
  return jwt.verify(token, env.jwtSecret) as VynzoTokenPayload;
}
