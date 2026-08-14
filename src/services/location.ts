export const EARTH_RADIUS_METERS = 6371000;
export const DEFAULT_PLATFORM_MAX_RADIUS_METERS = 5000; // 5 km maximum platform search radius

/**
 * Validates geographical latitude and longitude values
 */
export function isValidCoordinate(latitude: number, longitude: number): boolean {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return false;
  if (isNaN(latitude) || isNaN(longitude)) return false;
  if (latitude < -90 || latitude > 90) return false;
  if (longitude < -180 || longitude > 180) return false;
  return true;
}

/**
 * Calculates geographical distance in meters between two lat/lon coordinates using the Haversine formula
 */
export function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (!isValidCoordinate(lat1, lon1) || !isValidCoordinate(lat2, lon2)) {
    throw new Error('Invalid coordinates provided for Haversine calculation');
  }

  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(EARTH_RADIUS_METERS * c);
}

/**
 * Calculates the effective maximum radius allowed for matching
 * effectiveRadius = MIN(buyerSearchRadius, sellerServiceRadius, platformMaximumRadius)
 */
export function calculateEffectiveRadius(
  buyerRadiusMeters?: number,
  sellerServiceRadiusMeters: number = 500,
  platformMaxMeters: number = DEFAULT_PLATFORM_MAX_RADIUS_METERS
): number {
  const safeBuyerRadius = buyerRadiusMeters && buyerRadiusMeters > 0 ? buyerRadiusMeters : platformMaxMeters;
  const safeSellerRadius = sellerServiceRadiusMeters > 0 ? sellerServiceRadiusMeters : 500;
  
  return Math.min(safeBuyerRadius, safeSellerRadius, platformMaxMeters);
}

/**
 * Checks if calculated distance is within allowed effective service radius
 */
export function isWithinServiceRadius(
  distanceMeters: number,
  effectiveRadiusMeters: number
): boolean {
  return distanceMeters <= effectiveRadiusMeters;
}
