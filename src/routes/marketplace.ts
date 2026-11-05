import express, { Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { MarketplaceService } from '../services/marketplace.js';

const router = express.Router();

// ==========================================
// 1. REGISTER ENERGY SOURCE (SELLER)
// ==========================================
router.post('/sources', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { deviceId, name, latitude, longitude, serviceRadiusMeters } = req.body;

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
router.get('/nearby', async (req: express.Request, res: Response) => {
  try {
    const { latitude, longitude, radiusMeters } = req.query;

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

    const listingId = parseInt(`$req.params.id}`, 10);
    const { kwhRequested, buyerLatitude, buyerLongitude } = req.body;

    if (!kwhRequested || buyerLatitude === undefined || buyerLongitude === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: kwhRequested, buyerLatitude, buyerLongitude',
      });
    }

    const result = await MarketplaceService.createPurchaseIntent({
      buyerId: req.user.userId,
      listingId,
      kwhRequested: parseFloat(kwhRequested),
      buyerLatitude: parseFloat(buyerLatitude),
      buyerLongitude: parseFloat(buyerLongitude),
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
