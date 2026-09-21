import { OAuth2Client } from 'google-auth-library';
import { env } from './env';

export const googleClient = new OAuth2Client(
  env.googleClientId,
  env.googleClientSecret,
  env.googleRedirectUri
);

export function getGoogleAuthUrl(forceSelect?: boolean, mobileApp?: boolean) {
  const stateParts: string[] = [];
  if (forceSelect) stateParts.push('switch=true');
  if (mobileApp) stateParts.push('mobile=true');
  const state = stateParts.length > 0 ? stateParts.join(',') : undefined;

  return googleClient.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
    ...(state ? { state } : {}),
  });
}

export function parseOAuthState(state: string | undefined): { switch: boolean; mobileApp: boolean } {
  if (!state) {
    return { switch: false, mobileApp: false };
  }

  // Backward compatibility with the legacy mobile-only state format.
  if (state === 'frianzo_mobile') {
    return { switch: false, mobileApp: true };
  }

  let switchMode = false;
  let mobileApp = false;

  for (const part of state.split(',')) {
    const [key, value] = part.split('=');
    if (key === 'switch' && value === 'true') switchMode = true;
    if (key === 'mobile' && value === 'true') mobileApp = true;
  }

  return { switch: switchMode, mobileApp };
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
  if (!payload || !payload.sub || !payload.email) {
    throw new Error('Invalid Google token payload: email is required');
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

  if (!payload || !payload.sub || !payload.email) {
    throw new Error('Invalid Google token payload: email is required');
  }

  if (!payload.nonce || payload.nonce !== expectedNonce) {
    throw new Error('Invalid Google token nonce');
  }

  return {
    googleId: payload.sub,
    email: payload.email,
  };
}
