import pool from '../db.js';
import { calculateHaversineDistance, isValidCoordinate } from './location.js';

export async function createNotification(params: {
  userId: number;
  type: string;
  title: string;
  message: string;
  targetUrl: string;
  entityId?: number;
}) {
  const { userId, type, title, message, targetUrl, entityId } = params;
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, target_url, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, type, title, message, targetUrl, entityId ?? null]
  );
}

export async function notifyNearbyBuyersForListing(listingId: number, sellerId: number) {
  const listing = await pool.query(
    `SELECT l.id, s.id AS source_id, s.name AS source_name, s.latitude, s.longitude,
            s.service_radius_m, s.owner_id
     FROM energy_listings l
     JOIN energy_sources s ON s.id = l.energy_source_id
     WHERE l.id = $1 AND l.seller_id = $2 AND l.status = 'ACTIVE'
       AND s.status = 'ACTIVE'`,
    [listingId, sellerId]
  );
  if (!listing.rows.length) return 0;
  const source = listing.rows[0];
  const buyers = await pool.query(
    `SELECT a.user_id, a.latitude, a.longitude
     FROM buyer_alert_locations a
     JOIN users u ON u.id = a.user_id
     WHERE a.enabled = TRUE AND u.is_buyer = TRUE AND a.user_id <> $1`,
    [sellerId]
  );
  let notified = 0;
  for (const buyer of buyers.rows) {
    const latitude = Number(buyer.latitude);
    const longitude = Number(buyer.longitude);
    if (!isValidCoordinate(latitude, longitude)) continue;
    const distance = calculateHaversineDistance(
      latitude, longitude, Number(source.latitude), Number(source.longitude)
    );
    if (distance > Number(source.service_radius_m)) continue;
    await createNotification({
      userId: Number(buyer.user_id),
      type: 'NEARBY_ENERGY',
      title: 'Energy available near you',
      message: `${source.source_name} has published energy within its service area.`,
      targetUrl: `/marketplace?listingId=${listingId}`,
      entityId: listingId,
    });
    notified += 1;
  }
  return notified;
}
