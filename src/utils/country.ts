// Country normalisation (2026-11-02 country-feed fix).
// User.country was stored in two formats: a 2-letter code from profile
// setup auto-detect (e.g. "PK") and a full name from Settings (e.g.
// "Pakistan"). Feeds compared with strict ===, so "PK" === "Pakistan"
// was false and same-country authors silently got no bonus.
// Canonical format is now the 2-letter code, matching
// frontend/src/lib/countries.ts. Unknown values are kept as-is by
// callers that write, and return null here, so no data is destroyed.

const CODE_BY_NAME: Record<string, string> = {
  pakistan: 'PK', india: 'IN', bangladesh: 'BD', afghanistan: 'AF',
  'saudi arabia': 'SA', 'united arab emirates': 'AE', qatar: 'QA',
  kuwait: 'KW', oman: 'OM', bahrain: 'BH', turkey: 'TR',
  'united kingdom': 'GB', 'united states': 'US', canada: 'CA',
  australia: 'AU', germany: 'DE', france: 'FR', italy: 'IT',
  spain: 'ES', netherlands: 'NL', china: 'CN', japan: 'JP',
  'south korea': 'KR', malaysia: 'MY', indonesia: 'ID',
  thailand: 'TH', philippines: 'PH', singapore: 'SG',
  'sri lanka': 'LK', nepal: 'NP', iran: 'IR', iraq: 'IQ',
  egypt: 'EG', 'south africa': 'ZA', nigeria: 'NG', kenya: 'KE',
  brazil: 'BR', mexico: 'MX', russia: 'RU',
  tunisia: 'TN', czechia: 'CZ', 'czech republic': 'CZ', jordan: 'JO',
  romania: 'RO', tajikistan: 'TJ', slovenia: 'SI', belgium: 'BE',
  austria: 'AT', poland: 'PL', norway: 'NO', sweden: 'SE', denmark: 'DK',
  finland: 'FI', portugal: 'PT', greece: 'GR', ukraine: 'UA',
  kazakhstan: 'KZ', uzbekistan: 'UZ', yemen: 'YE', syria: 'SY',
  lebanon: 'LB', palestine: 'PS', israel: 'IL', ireland: 'IE',
  switzerland: 'CH', luxembourg: 'LU', albania: 'AL', croatia: 'HR',
  serbia: 'RS', georgia: 'GE', armenia: 'AM', azerbaijan: 'AZ',
  vietnam: 'VN', myanmar: 'MM', cambodia: 'KH', maldives: 'MV',
  bhutan: 'BT', algeria: 'DZ', morocco: 'MA', libya: 'LY', tanzania: 'TZ',
  uganda: 'UG', ghana: 'GH', ethiopia: 'ET',
};

const KNOWN_CODES = new Set(Object.values(CODE_BY_NAME));

export function normalizeCountry(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && KNOWN_CODES.has(upper)) return upper;
  // Common abbreviations that are not 2-letter codes.
  if (upper === 'USA' || upper === 'AMERICA') return 'US';
  if (upper === 'UAE') return 'AE';
  if (upper === 'UK') return 'GB';
  return CODE_BY_NAME[trimmed.toLowerCase()] ?? null;
}

/** True only when both sides normalise to the same known code. */
export function isSameCountry(a?: string | null, b?: string | null): boolean {
  const ca = normalizeCountry(a);
  if (!ca) return false;
  return ca === normalizeCountry(b);
}
