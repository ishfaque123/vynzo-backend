import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface VynzoTokenPayload {
  userId: string;
}

export function signToken(payload: VynzoTokenPayload): string {
  const sign: any = jwt.sign;
  return sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

export function verifyToken(token: string): VynzoTokenPayload {
  return jwt.verify(token, env.jwtSecret) as VynzoTokenPayload;
}
