import { OAuth2Client } from 'google-auth-library';
import { env } from './env';

export const googleClient = new OAuth2Client(
  env.googleClientId,
  env.googleClientSecret,
  env.googleRedirectUri
);

export function getGoogleAuthUrl(forceSelect?: boolean, mobileApp?: boolean) {
  return googleClient.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
    ...(mobileApp ? { state: 'frianzo_mobile' } : {}),
  });
}

export async function getGoogleUserFromCode(code: string) {
  const { tokens } = await googleClient.getToken(code);
  if (!tokens.id_token) {
    throw new Error('No ID token returned from Google');
  }
  const ticket = await googleClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.googleClientId,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new Error('Invalid Google token payload');
  }
  return {
    googleId: payload.sub,
    email: payload.email,
  };
}

export async function getGoogleUserFromIdToken(idToken: string, expectedNonce: string) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: env.googleClientId,
  });
  const payload = ticket.getPayload();

  if (!payload || !payload.sub) {
    throw new Error('Invalid Google token payload');
  }

  if (!payload.nonce || payload.nonce !== expectedNonce) {
    throw new Error('Invalid Google token nonce');
  }

  return {
    googleId: payload.sub,
    email: payload.email,
  };
}
