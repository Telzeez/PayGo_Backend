import express, { Response } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { MarketplaceService } from '../services/marketplace.js';
import { calculateHaversineDistance, isValidCoordinate } from '../services/location.js';

const router = express.Router();

// Lightweight per-IP discovery throttle; keeps repeated coordinate probing bounded.
const nearbyRequests = new Map<string, { count: number; resetAt: number }>();
const nearbyRateLimit: express.RequestHandler = (req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = nearbyRequests.get(key);
  if (!current || current.resetAt <= now) {
    nearbyRequests.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (current.count >= 30) return res.status(429).json({ success: false, error: 'Too many nearby searches. Please wait a minute and try again.' });
  current.count += 1;
  return next();
};

// ==========================================
// Buyer coordinates are transient discovery input; never persist them.
router.post('/location', authenticateToken, async (_req: AuthenticatedRequest, res: Response) => {
  return res.status(410).json({ success: false, error: 'Buyer locations are used only for nearby discovery and are not saved.' });
});
router.get('/location/me', authenticateToken, async (_req: AuthenticatedRequest, res: Response) => {
  return res.json({ success: true, location: null });
});

// Seller location verification and listing lifecycle.
const SELLER_LOCATION_MAX_DISTANCE_METERS = Math.max(1, Number.parseInt(process.env.PAYGO_SELLER_LOCATION_MAX_DISTANCE_METERS || '50', 10) || 50);
const SELLER_LOCATION_TOLERANCE_METERS = 5;
async function validateSellerLocation(req: AuthenticatedRequest, sourceId: number) {
  const latitude = Number(req.body?.latitude), longitude = Number(req.body?.longitude);
  const accuracy = Number(req.body?.accuracy), timestamp = Number(req.body?.ts);
  if (!isValidCoordinate(latitude, longitude)) throw new Error('A valid current location is required.');
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 20) throw new Error('Your location signal is not clear enough yet. Please wait for a more accurate reading.');
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 120000) throw new Error('This location reading has expired. Please capture your location again.');
  const result = await pool.query('SELECT id, latitude, longitude FROM energy_sources WHERE id = $1 AND owner_id = $2 LIMIT 1', [sourceId, req.user!.userId]);
  if (!result.rows.length) throw new Error('Energy source not found or access denied.');
  const source = result.rows[0];
  const distance = calculateHaversineDistance(latitude, longitude, Number(source.latitude), Number(source.longitude));
  if (distance > SELLER_LOCATION_MAX_DISTANCE_METERS + SELLER_LOCATION_TOLERANCE_METERS) throw new Error(`You are about ${distance} m from the saved meter location. Move closer (within ${SELLER_LOCATION_MAX_DISTANCE_METERS} m) and try again.`);
  return { latitude, longitude, accuracy, distance };
}
router.put('/sources/:id/location', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required' });
    const sourceId = Number.parseInt(String(req.params.id), 10);
    const checked = await validateSellerLocation(req, sourceId);
    await pool.query('UPDATE energy_sources SET latitude = $1, longitude = $2, location_accuracy_m = $3, location_set_at = NOW(), location_verified_at = NOW(), updated_at = NOW() WHERE id = $4 AND owner_id = $5', [checked.latitude, checked.longitude, checked.accuracy, sourceId, req.user.userId]);
    await pool.query("INSERT INTO energy_source_location_events (energy_source_id, actor_user_id, event_type, latitude, longitude, accuracy_m, distance_from_previous_m) VALUES ($1, $2, 'LOCATION_UPDATED', $3, $4, $5, $6)", [sourceId, req.user.userId, checked.latitude, checked.longitude, checked.accuracy, checked.distance]);
    return res.json({ success: true, message: 'Your meter location has been verified.', distanceMeters: checked.distance });
  } catch (error: any) { return res.status(400).json({ success: false, error: error.message || 'Unable to verify this location.' }); }
});
router.post('/sources/:id/revoke', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const client = await pool.connect();
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required' });
    const sourceId = Number.parseInt(String(req.params.id), 10);
    await client.query('BEGIN');
    const source = await client.query('SELECT id FROM energy_sources WHERE id = $1 AND owner_id = $2 FOR UPDATE', [sourceId, req.user.userId]);
    if (!source.rows.length) throw new Error('Energy source not found or access denied.');
    await client.query("UPDATE energy_sources SET status = 'SUSPENDED', updated_at = NOW() WHERE id = $1", [sourceId]);
    await client.query("UPDATE energy_listings SET status = 'REVOKED', updated_at = NOW() WHERE energy_source_id = $1 AND status <> 'REVOKED'", [sourceId]);
    await client.query("INSERT INTO energy_source_location_events (energy_source_id, actor_user_id, event_type) VALUES ($1, $2, 'REVOKED')", [sourceId, req.user.userId]);
    await client.query('COMMIT');
    return res.json({ success: true, message: 'Your energy listing has been revoked.' });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ success: false, error: error.message || 'Unable to revoke listing.' });
  } finally { client.release(); }
});
router.post('/sources/:id/relist', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const client = await pool.connect();
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required' });
    const sourceId = Number.parseInt(String(req.params.id), 10);
    const checked = await validateSellerLocation(req, sourceId);
    await client.query('BEGIN');
    await client.query("UPDATE energy_sources SET status = 'ACTIVE', latitude = $1, longitude = $2, location_accuracy_m = $3, location_set_at = NOW(), location_verified_at = NOW(), updated_at = NOW() WHERE id = $4 AND owner_id = $5", [checked.latitude, checked.longitude, checked.accuracy, sourceId, req.user.userId]);
    const restored = await client.query("UPDATE energy_listings SET status = 'ACTIVE', updated_at = NOW() WHERE energy_source_id = $1 AND seller_id = $2 AND status = 'REVOKED' RETURNING id", [sourceId, req.user.userId]);
    if (!restored.rows.length) throw new Error('There is no revoked offer to relist. Create a new offer instead.');
    await client.query("INSERT INTO energy_source_location_events (energy_source_id, actor_user_id, event_type, latitude, longitude, accuracy_m, distance_from_previous_m) VALUES ($1, $2, 'RELISTED', $3, $4, $5, $6)", [sourceId, req.user.userId, checked.latitude, checked.longitude, checked.accuracy, checked.distance]);
    await client.query('COMMIT');
    return res.json({ success: true, message: 'Your listing is active again.' });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ success: false, error: error.message || 'Unable to relist this offer.' });
  } finally { client.release(); }
});

// 1. REGISTER ENERGY SOURCE (SELLER)
// ==========================================
router.post('/sources', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { deviceId, name, latitude, longitude, accuracy, ts, serviceRadiusMeters } = req.body;

    if (!deviceId || !name || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: deviceId, name, latitude, longitude',
      });
    }

    const source = await MarketplaceService.createSource({
      ownerId: req.user.userId,
      deviceId,
      name,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      accuracy: accuracy === undefined ? undefined : parseFloat(accuracy),
      ts: ts === undefined ? undefined : Number(ts),
      serviceRadiusMeters: serviceRadiusMeters ? parseInt(serviceRadiusMeters, 10) : 500,
    });

    return res.status(201).json({
      success: true,
      message: 'Energy source registered successfully',
      source,
    });
  } catch (error: any) {
    console.error('Create source error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to create energy source' });
  }
});

// ==========================================
// 2. GET SELLER'S ENERGY SOURCES
// ==========================================
router.get('/sources/me', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const sources = await MarketplaceService.getSellerSources(req.user.userId);
    return res.json({ success: true, sources });
  } catch (error: any) {
    console.error('Get seller sources error:', error);
    return res.status(500).json({ success: false, error: 'Failed to retrieve energy sources' });
  }
});

// ==========================================
// 3. CREATE ENERGY LISTING (SELLER)
// ==========================================
router.post('/listings', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { energySourceId, availableKwh, pricePerKwh, expiresInHours } = req.body;

    if (!energySourceId || availableKwh === undefined || pricePerKwh === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: energySourceId, availableKwh, pricePerKwh',
      });
    }

    const listing = await MarketplaceService.createListing({
      sellerId: req.user.userId,
      energySourceId: parseInt(energySourceId, 10),
      availableKwh: parseFloat(availableKwh),
      pricePerKwh: parseFloat(pricePerKwh),
      expiresInHours: expiresInHours ? parseInt(expiresInHours, 10) : 72,
    });

    return res.status(201).json({
      success: true,
      message: 'Energy listing published successfully',
      listing,
    });
  } catch (error: any) {
    console.error('Create listing error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to publish energy listing' });
  }
});

// ==========================================
// 4. GET SELLER'S LISTINGS
// ==========================================
router.get('/my-listings', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const listings = await MarketplaceService.getSellerListings(req.user.userId);
    return res.json({ success: true, listings });
  } catch (error: any) {
    console.error('Get seller listings error:', error);
    return res.status(500).json({ success: false, error: 'Failed to retrieve listings' });
  }
});

// ==========================================
// 5. PAUSE / ACTIVATE LISTING
// ==========================================
router.post('/listings/:id/pause', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const listingId = parseInt(`${req.params.id}`, 10);
    const listing = await MarketplaceService.toggleListingStatus(req.user.userId, listingId, 'PAUSED');
    return res.json({ success: true, message: 'Listing paused', listing });
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error.message || 'Failed to pause listing' });
  }
});

router.post('/listings/:id/activate', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

  const listingId = parseInt(`${req.params.id}`, 10);

    const listing = await MarketplaceService.toggleListingStatus(req.user.userId, listingId, 'ACTIVE');
    return res.json({ success: true, message: 'Listing activated', listing });
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error.message || 'Failed to activate listing' });
  }
});

// ==========================================
// 6. BUYER DISCOVERY: GET NEARBY LISTINGS
// ==========================================
router.get('/nearby', nearbyRateLimit, async (req: express.Request, res: Response) => {
  try {
    const latitude = req.query.lat ?? req.query.latitude;
    const longitude = req.query.lng ?? req.query.longitude;
    const radiusMeters = req.query.radius ?? req.query.radiusMeters;

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Buyer latitude and longitude query parameters are required',
      });
    }

    const buyerLatitude = parseFloat(latitude as string);
    const buyerLongitude = parseFloat(longitude as string);
    const buyerRadius = radiusMeters ? parseInt(radiusMeters as string, 10) : undefined;

    const nearby = await MarketplaceService.getNearbyListings({
      buyerLatitude,
      buyerLongitude,
      buyerRadiusMeters: buyerRadius,
    });

    return res.json({
      success: true,
      count: nearby.length,
      listings: nearby,
    });
  } catch (error: any) {
    console.error('Nearby discovery error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to search nearby listings' });
  }
});

// ==========================================
// 7. CREATE PURCHASE INTENT
// ==========================================
router.post('/listings/:id/purchase', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const listingId = parseInt(`${req.params.id}`, 10);
    const { kwhRequested, buyerDeviceId } = req.body;

    if (!kwhRequested || !buyerDeviceId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: kwhRequested, buyerDeviceId',
      });
    }

    const result = await MarketplaceService.createPurchaseIntent({
      buyerId: req.user.userId,
      buyerDeviceId,
      listingId,
      kwhRequested: parseFloat(kwhRequested),
    });

    return res.status(201).json({
      success: true,
      message: 'Purchase intent created successfully',
      purchase: result.purchase,
    });
  } catch (error: any) {
    console.error('Purchase intent error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to create purchase intent' });
  }
});

// ==========================================
// 8. GET BUYER PURCHASES
// ==========================================
router.get('/purchases', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const purchases = await MarketplaceService.getBuyerPurchases(req.user.userId);
    return res.json({ success: true, purchases });
  } catch (error: any) {
    console.error('Get purchases error:', error);
    return res.status(500).json({ success: false, error: 'Failed to retrieve purchases' });
  }
});

// ==========================================
// 9. GET PURCHASE DETAIL
// ==========================================
router.get('/purchases/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const purchaseId = parseInt(req.params.id as string, 10);
    const purchase = await MarketplaceService.getPurchaseDetail(req.user.userId, purchaseId);
    return res.json({ success: true, purchase });
  } catch (error: any) {
    console.error('Get purchase detail error:', error);
    return res.status(404).json({ success: false, error: 'Purchase not found' });
  }
});

export default router;
