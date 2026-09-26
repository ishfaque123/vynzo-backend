// Free reverse geocoding via OpenStreetMap's Nominatim. No API key needed.
// Nominatim's usage policy requires a real User-Agent identifying the app
// and a low request rate — this is only called when a user explicitly taps
// "Use current location" in the composer, so volume stays naturally low.
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FrianzoApp/1.0 (https://frianzo.online)' },
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const addr = data?.address;
  if (!addr) return data?.display_name ?? null;

  const place = addr.city || addr.town || addr.village || addr.suburb || addr.county;
  const region = addr.state;
  const country = addr.country;
  const parts = [place, region, country].filter(Boolean);
  return parts.length ? parts.join(', ') : (data?.display_name ?? null);
}
