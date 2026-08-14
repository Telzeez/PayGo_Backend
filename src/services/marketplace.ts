import pool from '../db.js';
import {
  calculateHaversineDistance,
  calculateEffectiveRadius,
  isWithinServiceRadius,
  isValidCoordinate,
  DEFAULT_PLATFORM_MAX_RADIUS_METERS,
} from './location.js';
import {
  EnergySource,
  EnergyListing,
  MarketplacePurchase,
  NearbyListingItem,
} from '../types/marketplace.js';

export class MarketplaceService {
  /**
   * Register a new Energy Source (Solar System tied to a device)
   */
  static async createSource(params: {
    ownerId: number;
    deviceId: string;
    name: string;
    latitude: number;
    longitude: number;
    serviceRadiusMeters?: number;
  }): Promise<EnergySource> {
    const { ownerId, deviceId, name, latitude, longitude, serviceRadiusMeters = 500 } = params;

    if (!isValidCoordinate(latitude, longitude)) {
      throw new Error('Invalid latitude or longitude coordinates');
    }

    if (serviceRadiusMeters <= 0 || serviceRadiusMeters > DEFAULT_PLATFORM_MAX_RADIUS_METERS) {
      throw new Error(`Service radius must be between 1 and ${DEFAULT_PLATFORM_MAX_RADIUS_METERS} meters`);
    }

    // Verify device exists
    const deviceCheck = await pool.query('SELECT id FROM devices WHERE device_id = $1', [deviceId]);
    if (deviceCheck.rows.length === 0) {
      // Auto-register device if missing for seamless setup
      await pool.query('INSERT INTO devices (device_id, current_balance, status) VALUES ($1, 0, $2)', [
        deviceId,
        'ONLINE',
      ]);
    }

    const result = await pool.query(
      `INSERT INTO energy_sources 
       (owner_id, device_id, name, latitude, longitude, service_radius_m, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
       RETURNING id, owner_id AS "ownerId", device_id AS "deviceId", name, latitude, longitude,
                 service_radius_m AS "serviceRadiusMeters", status, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [ownerId, deviceId, name, latitude, longitude, serviceRadiusMeters]
    );

    return result.rows[0];
  }

  /**
   * Fetch all energy sources owned by a seller
   */
  static async getSellerSources(ownerId: number): Promise<EnergySource[]> {
    const result = await pool.query(
      `SELECT id, owner_id AS "ownerId", device_id AS "deviceId", name, latitude, longitude,
              service_radius_m AS "serviceRadiusMeters", status, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM energy_sources
       WHERE owner_id = $1 AND status != 'DECOMMISSIONED'
       ORDER BY created_at DESC`,
      [ownerId]
    );
    return result.rows;
  }

  /**
   * Create a new energy listing for sale
   */
  static async createListing(params: {
    sellerId: number;
    energySourceId: number;
    availableKwh: number;
    pricePerKwh: number;
    expiresInHours?: number;
  }): Promise<EnergyListing> {
    const { sellerId, energySourceId, availableKwh, pricePerKwh, expiresInHours = 72 } = params;

    if (availableKwh <= 0) {
      throw new Error('Available energy must be greater than 0 kWh');
    }

    if (pricePerKwh <= 0) {
      throw new Error('Price per kWh must be a positive number');
    }

    // Verify source ownership
    const sourceCheck = await pool.query(
      'SELECT id FROM energy_sources WHERE id = $1 AND owner_id = $2 AND status = \'ACTIVE\'',
      [energySourceId, sellerId]
    );

    if (sourceCheck.rows.length === 0) {
      throw new Error('Active energy source not found or access denied');
    }

    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();

    const result = await pool.query(
      `INSERT INTO energy_listings
       (energy_source_id, seller_id, available_kwh, reserved_kwh, price_per_kwh, status, expires_at)
       VALUES ($1, $2, $3, 0, $4, 'ACTIVE', $5)
       RETURNING id, energy_source_id AS "energySourceId", seller_id AS "sellerId",
                 available_kwh AS "availableKwh", reserved_kwh AS "reservedKwh",
                 price_per_kwh AS "pricePerKwh", status, expires_at AS "expiresAt",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [energySourceId, sellerId, availableKwh, pricePerKwh, expiresAt]
    );

    return result.rows[0];
  }

  /**
   * Fetch all listings published by a seller
   */
  static async getSellerListings(sellerId: number): Promise<EnergyListing[]> {
    const result = await pool.query(
      `SELECT id, energy_source_id AS "energySourceId", seller_id AS "sellerId",
              available_kwh AS "availableKwh", reserved_kwh AS "reservedKwh",
              price_per_kwh AS "pricePerKwh", status, expires_at AS "expiresAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM energy_listings
       WHERE seller_id = $1
       ORDER BY created_at DESC`,
      [sellerId]
    );
    return result.rows;
  }

  /**
   * Pause or Activate an energy listing
   */
  static async toggleListingStatus(
    sellerId: number,
    listingId: number,
    status: 'ACTIVE' | 'PAUSED'
  ): Promise<EnergyListing> {
    const result = await pool.query(
      `UPDATE energy_listings
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND seller_id = $3
       RETURNING id, energy_source_id AS "energySourceId", seller_id AS "sellerId",
                 available_kwh AS "availableKwh", reserved_kwh AS "reservedKwh",
                 price_per_kwh AS "pricePerKwh", status, expires_at AS "expiresAt",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [status, listingId, sellerId]
    );

    if (result.rows.length === 0) {
      throw new Error('Listing not found or access denied');
    }

    return result.rows[0];
  }

  /**
   * Location Discovery Engine: Find nearby eligible active energy listings
   */
  static async getNearbyListings(params: {
    buyerLatitude: number;
    buyerLongitude: number;
    buyerRadiusMeters?: number;
  }): Promise<NearbyListingItem[]> {
    const { buyerLatitude, buyerLongitude, buyerRadiusMeters } = params;

    if (!isValidCoordinate(buyerLatitude, buyerLongitude)) {
      throw new Error('Invalid buyer latitude or longitude');
    }

    // Query active listings joined with source, seller and device status
    const query = `
      SELECT 
        l.id AS "listingId",
        s.id AS "sourceId",
        s.name AS "sourceName",
        s.owner_id AS "sellerId",
        u.email AS "sellerEmail",
        s.device_id AS "deviceId",
        s.latitude AS "sourceLatitude",
        s.longitude AS "sourceLongitude",
        s.service_radius_m AS "serviceRadiusMeters",
        l.available_kwh AS "availableKwhRaw",
        l.reserved_kwh AS "reservedKwhRaw",
        l.price_per_kwh AS "pricePerKwhRaw",
        l.status AS "status",
        COALESCE(d.status, 'OFFLINE') AS "deviceStatus",
        d.last_seen_at AS "lastSeenAt"
      FROM energy_listings l
      JOIN energy_sources s ON l.energy_source_id = s.id
      JOIN users u ON s.owner_id = u.id
      LEFT JOIN devices d ON s.device_id = d.device_id
      WHERE l.status = 'ACTIVE'
        AND s.status = 'ACTIVE'
        AND (l.expires_at IS NULL OR l.expires_at > NOW())
    `;

    const result = await pool.query(query);
    const nearbyListings: NearbyListingItem[] = [];

    for (const row of result.rows) {
      const sourceLat = parseFloat(row.sourceLatitude);
      const sourceLon = parseFloat(row.sourceLongitude);
      const availableKwh = parseFloat(row.availableKwhRaw || 0);
      const reservedKwh = parseFloat(row.reservedKwhRaw || 0);
      const remainingSellable = availableKwh - reservedKwh;

      // Rule: Exclude sold out or depleted listings
      if (remainingSellable <= 0) continue;

      // Calculate Haversine distance
      const distanceMeters = calculateHaversineDistance(
        buyerLatitude,
        buyerLongitude,
        sourceLat,
        sourceLon
      );

      // Calculate Effective Radius: MIN(buyerRadius, sellerServiceRadius, platformMax)
      const effectiveRadiusMeters = calculateEffectiveRadius(
        buyerRadiusMeters,
        row.serviceRadiusMeters,
        DEFAULT_PLATFORM_MAX_RADIUS_METERS
      );

      // Rule: Exclude if distance exceeds effective radius
      if (!isWithinServiceRadius(distanceMeters, effectiveRadiusMeters)) continue;

      nearbyListings.push({
        listingId: row.listingId,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        sellerId: row.sellerId,
        sellerEmail: row.sellerEmail,
        deviceId: row.deviceId,
        distanceMeters,
        effectiveRadiusMeters,
        availableKwh: remainingSellable,
        pricePerKwh: parseFloat(row.pricePerKwhRaw),
        status: row.status,
        deviceStatus: row.deviceStatus as 'ONLINE' | 'OFFLINE',
        lastSeenAt: row.lastSeenAt,
        sourceLatitude: sourceLat,
        sourceLongitude: sourceLon,
      });
    }

    // Deterministic Ranking Engine:
    // 1. Device status ONLINE first
    // 2. Distance ASC (closest first)
    // 3. Price ASC (cheapest first)
    // 4. Available kWh DESC (most energy first)
    nearbyListings.sort((a, b) => {
      if (a.deviceStatus === 'ONLINE' && b.deviceStatus !== 'ONLINE') return -1;
      if (a.deviceStatus !== 'ONLINE' && b.deviceStatus === 'ONLINE') return 1;
      if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters;
      if (a.pricePerKwh !== b.pricePerKwh) return a.pricePerKwh - b.pricePerKwh;
      return b.availableKwh - a.availableKwh;
    });

    return nearbyListings;
  }

  /**
   * Concurrency-safe Purchase Intent Creation with energy reservation & distance recalculation
   */
  static async createPurchaseIntent(params: {
    buyerId: number;
    listingId: number;
    kwhRequested: number;
    buyerLatitude: number;
    buyerLongitude: number;
  }): Promise<{ purchase: MarketplacePurchase; redirectUrl?: string }> {
    const { buyerId, listingId, kwhRequested, buyerLatitude, buyerLongitude } = params;

    if (kwhRequested <= 0) {
      throw new Error('Requested energy must be greater than 0 kWh');
    }

    if (!isValidCoordinate(buyerLatitude, buyerLongitude)) {
      throw new Error('Invalid buyer latitude or longitude coordinates');
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Lock listing row for update to prevent concurrent overselling
      const listingRes = await client.query(
        `SELECT l.id, l.seller_id, l.energy_source_id, l.available_kwh, l.reserved_kwh, l.price_per_kwh, l.status,
                s.device_id, s.latitude AS source_lat, s.longitude AS source_lon, s.service_radius_m
         FROM energy_listings l
         JOIN energy_sources s ON l.energy_source_id = s.id
         WHERE l.id = $1 FOR UPDATE`,
        [listingId]
      );

      if (listingRes.rows.length === 0) {
        throw new Error('Marketplace listing not found');
      }

      const listing = listingRes.rows[0];

      if (listing.status !== 'ACTIVE') {
        throw new Error('Listing is no longer active for purchase');
      }

      if (listing.seller_id === buyerId) {
        throw new Error('Sellers cannot purchase from their own energy listing');
      }

      const availableKwh = parseFloat(listing.available_kwh);
      const reservedKwh = parseFloat(listing.reserved_kwh);
      const remainingSellable = availableKwh - reservedKwh;

      if (remainingSellable < kwhRequested) {
        throw new Error(`Only ${remainingSellable.toFixed(2)} kWh remains available for purchase`);
      }

      // Server-side distance recalculation at purchase time
      const sourceLat = parseFloat(listing.source_lat);
      const sourceLon = parseFloat(listing.source_lon);
      const distanceMeters = calculateHaversineDistance(
        buyerLatitude,
        buyerLongitude,
        sourceLat,
        sourceLon
      );

      const effectiveRadiusMeters = calculateEffectiveRadius(
        DEFAULT_PLATFORM_MAX_RADIUS_METERS,
        listing.service_radius_m
      );

      if (!isWithinServiceRadius(distanceMeters, effectiveRadiusMeters)) {
        throw new Error(`Buyer location (${distanceMeters}m) is outside allowed service radius (${effectiveRadiusMeters}m)`);
      }

      const pricePerKwh = parseFloat(listing.price_per_kwh);
      const amount = Math.round(kwhRequested * pricePerKwh);

      // Increment reserved energy
      await client.query(
        `UPDATE energy_listings 
         SET reserved_kwh = reserved_kwh + $1, updated_at = NOW()
         WHERE id = $2`,
        [kwhRequested, listingId]
      );

      // Generate unique purchase reference for idempotency
      const purchaseReference = `MKT_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

      const purchaseRes = await client.query(
        `INSERT INTO marketplace_purchases
         (purchase_reference, listing_id, buyer_id, seller_id, device_id, distance_m, price_per_kwh, kwh_requested, amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'RESERVED')
         RETURNING id, purchase_reference AS "purchaseReference", listing_id AS "listingId",
                   buyer_id AS "buyerId", seller_id AS "sellerId", device_id AS "deviceId",
                   distance_m AS "distanceMeters", price_per_kwh AS "pricePerKwh",
                   kwh_requested AS "kwhRequested", amount, status, created_at AS "createdAt"`,
        [
          purchaseReference,
          listingId,
          buyerId,
          listing.seller_id,
          listing.device_id,
          distanceMeters,
          pricePerKwh,
          kwhRequested,
          amount,
        ]
      );

      await client.query('COMMIT');

      return {
        purchase: purchaseRes.rows[0],
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Automatically releases stale energy reservations (> 15 minutes old) where payment was abandoned
   */
  static async expireStaleReservations(expiryMinutes: number = 15): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Fetch stale purchases
      const staleRes = await client.query(
        `SELECT id, listing_id, kwh_requested
         FROM marketplace_purchases
         WHERE status = 'RESERVED' AND created_at < NOW() - ($1 || ' minutes')::INTERVAL
         FOR UPDATE`,
        [expiryMinutes]
      );

      let expiredCount = 0;

      for (const row of staleRes.rows) {
        const kwhToRelease = parseFloat(row.kwh_requested);

        // Reconcile reserved_kwh on energy_listings
        await client.query(
          `UPDATE energy_listings
           SET reserved_kwh = GREATEST(0, reserved_kwh - $1), updated_at = NOW()
           WHERE id = $2`,
          [kwhToRelease, row.listing_id]
        );

        // Mark purchase status as EXPIRED
        await client.query(
          `UPDATE marketplace_purchases
           SET status = 'EXPIRED', updated_at = NOW()
           WHERE id = $1`,
          [row.id]
        );

        expiredCount++;
      }

      await client.query('COMMIT');
      return expiredCount;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error expiring stale reservations:', error);
      return 0;
    } finally {
      client.release();
    }
  }

  /**
   * Get all purchases for a buyer
   */
  static async getBuyerPurchases(buyerId: number): Promise<MarketplacePurchase[]> {
    const result = await pool.query(
      `SELECT p.id, p.purchase_reference AS "purchaseReference", p.listing_id AS "listingId",
              p.buyer_id AS "buyerId", p.seller_id AS "sellerId", p.device_id AS "deviceId",
              p.distance_m AS "distanceMeters", p.price_per_kwh AS "pricePerKwh",
              p.kwh_requested AS "kwhRequested", p.amount, p.status, p.paystack_reference AS "paystackReference",
              p.created_at AS "createdAt", p.updated_at AS "updatedAt",
              t.hardware_status AS "hardwareStatus", s.name AS "sourceName"
       FROM marketplace_purchases p
       LEFT JOIN transactions t ON p.paystack_reference = t.reference
       LEFT JOIN energy_listings l ON p.listing_id = l.id
       LEFT JOIN energy_sources s ON l.energy_source_id = s.id
       WHERE p.buyer_id = $1
       ORDER BY p.created_at DESC`,
      [buyerId]
    );
    return result.rows;
  }

  /**
   * Get purchase detail for a buyer
   */
  static async getPurchaseDetail(buyerId: number, purchaseId: number): Promise<any> {
    const result = await pool.query(
      `SELECT p.id, p.purchase_reference AS "purchaseReference", p.listing_id AS "listingId",
              p.buyer_id AS "buyerId", p.seller_id AS "sellerId", p.device_id AS "deviceId",
              p.distance_m AS "distanceMeters", p.price_per_kwh AS "pricePerKwh",
              p.kwh_requested AS "kwhRequested", p.amount, p.status, p.paystack_reference AS "paystackReference",
              p.created_at AS "createdAt", p.updated_at AS "updatedAt",
              t.hardware_status AS "hardwareStatus", s.name AS "sourceName",
              t.transaction_id AS "transactionId"
       FROM marketplace_purchases p
       LEFT JOIN transactions t ON p.paystack_reference = t.reference
       LEFT JOIN energy_listings l ON p.listing_id = l.id
       LEFT JOIN energy_sources s ON l.energy_source_id = s.id
       WHERE p.buyer_id = $1 AND p.id = $2`,
      [buyerId, purchaseId]
    );

    if (result.rows.length === 0) {
      throw new Error('Purchase not found');
    }
    
    return result.rows[0];
  }
}
