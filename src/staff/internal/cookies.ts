import type { FastifyRequest } from 'fastify';

export const sessionCookieName = 'dona_session';

// Cloud Run terminates TLS at Google's front end, so the process itself always
// sees plain http and `request.protocol` alone would never mark the cookie
// Secure in production. The forwarded header is read explicitly rather than by
// switching Fastify's global trustProxy on: that would also make `request.ip`
// believe a client-supplied header, and per-IP decisions are a week-6 choice to
// be made deliberately, not a side effect of wanting a cookie flag.
export function isHttps(request: FastifyRequest): boolean {
  return (
    request.protocol === 'https' ||
    request.headers['x-forwarded-proto'] === 'https'
  );
}

export function sessionCookie(
  token: string,
  expiresAt: Date,
  now: Date,
  secure: boolean,
): string {
  const maxAge = Math.max(
    0,
    Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
  );
  return attributes(`${sessionCookieName}=${token}`, maxAge, secure);
}

export function clearSessionCookie(secure: boolean): string {
  return attributes(`${sessionCookieName}=`, 0, secure);
}

function attributes(pair: string, maxAge: number, secure: boolean): string {
  // SameSite=Lax blocks cookie-bearing cross-site POSTs, which is what protects
  // logout. HttpOnly keeps the token away from any script on the page.
  const parts = [
    pair,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function readSessionToken(
  cookieHeader: string | undefined,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const cut = trimmed.indexOf('=');
    if (cut > 0 && trimmed.slice(0, cut) === sessionCookieName) {
      const value = trimmed.slice(cut + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}
