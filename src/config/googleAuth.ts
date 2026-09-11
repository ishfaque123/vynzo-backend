import { OAuth2Client } from 'google-auth-library';
import { env } from './env';

export const googleClient = new OAuth2Client(
  env.googleClientId,
  env.googleClientSecret,
  env.googleRedirectUri
);

export function getGoogleAuthUrl(forceSelect?: boolean) {
  return googleClient.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
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
