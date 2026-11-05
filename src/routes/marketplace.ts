import express, { Response } from 'express';
import axios from 'axios';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middlewares/authMiddleware.js';
import { MarketplaceService } from '../services/marketplace.js';
import pool from '../db.js';

const router = express.Router();
const PAYSTACK_API_URL = 'https://api.paystack.co';
const SELLER_PAYOUT_PERCENTAGE = 90;
const PLATFORM_COMMISSION_PERCENTAGE = 100 - SELLER_PAYOUT_PERCENTAGE;

const getPaystackHeaders = (secret: string) => ({
  Authorization: `Bearer ${secret}`,
  'Content-Type': 'application/json',
});

router.get('/payout-account/banks', authenticateToken, requireRole(['SELLER', 'OWNER']), async (_req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(503).json({ success: false, error: 'Payout account setup is temporarily unavailable.' });
  }

  try {
    const response = await axios.get(`${PAYSTACK_API_URL}/bank?country=nigeria&currency=NGN&perPage=100`, {
      headers: getPaystackHeaders(secret),
      timeout: 10000,
    });
    if (!response.data.status || !Array.isArray(response.data.data)) {
      return res.status(502).json({ success: false, error: 'Unable to retrieve payout banks from Paystack.' });
    }

    return res.json({
      success: true,
      banks: response.data.data
        .filter((bank: { active?: boolean }) => bank.active !== false)
        .map((bank: { name: string; code: string }) => ({ name: bank.name, code: bank.code })),
    });
  } catch (error) {
    console.error('Paystack bank lookup failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(502).json({ success: false, error: 'Unable to retrieve payout banks from Paystack.' });
  }
});

router.get('/payout-account', authenticateToken, requireRole(['SELLER', 'OWNER']), async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  try {
    const result = await pool.query(
      `SELECT payout_bank_name AS "bankName", payout_account_name AS "accountName",
              payout_account_last4 AS "accountNumberLast4", paystack_subaccount_code AS "subaccountCode"
       FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Seller account not found.' });
    }

    const account = result.rows[0];
    return res.json({
      success: true,
      account: {
        configured: Boolean(account.subaccountCode),
        bankName: account.bankName,
        accountName: account.accountName,
        accountNumberLast4: account.accountNumberLast4,
        sellerPayoutPercentage: SELLER_PAYOUT_PERCENTAGE,
      },
    });
  } catch (error) {
    console.error('Payout account lookup failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({ success: false, error: 'Unable to retrieve payout account.' });
  }
});

router.put('/payout-account', authenticateToken, requireRole(['SELLER', 'OWNER']), async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  const businessName = typeof req.body.businessName === 'string' ? req.body.businessName.trim() : '';
  const bankCode = typeof req.body.bankCode === 'string' ? req.body.bankCode.trim() : '';
  const accountNumber = typeof req.body.accountNumber === 'string' ? req.body.accountNumber.trim() : '';

  if (!businessName || businessName.length > 100 || !bankCode || bankCode.length > 50 || !/^\d{10}$/.test(accountNumber)) {
    return res.status(400).json({
      success: false,
      error: 'Provide a business name, bank, and valid 10-digit Nigerian account number.',
    });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(503).json({ success: false, error: 'Payout account setup is temporarily unavailable.' });
  }

  const headers = getPaystackHeaders(secret);
  try {
    const bankResult = await axios.get(`${PAYSTACK_API_URL}/bank?country=nigeria&currency=NGN&perPage=100`, {
      headers,
      timeout: 10000,
    });
    const bankName = Array.isArray(bankResult.data.data)
      ? bankResult.data.data.find((bank: { code: string }) => bank.code === bankCode)?.name
      : undefined;
    if (!bankResult.data.status || !bankName) {
      return res.status(422).json({ success: false, error: 'The selected bank is not available for Nigerian payouts.' });
    }

    const verification = await axios.get(
      `${PAYSTACK_API_URL}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers, timeout: 10000 }
    );
    if (!verification.data.status || !verification.data.data?.account_name) {
      return res.status(422).json({ success: false, error: 'Paystack could not verify this bank account.' });
    }

    const accountName = String(verification.data.data.account_name);
    const existingAccount = await pool.query<{ subaccountCode: string | null }>(
      'SELECT paystack_subaccount_code AS "subaccountCode" FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (existingAccount.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Seller account not found.' });
    }

    const subaccountPayload = {
      business_name: businessName,
      settlement_bank: bankCode,
      account_number: accountNumber,
      percentage_charge: PLATFORM_COMMISSION_PERCENTAGE,
    };
    const subaccountResponse = existingAccount.rows[0].subaccountCode
      ? await axios.put(
        `${PAYSTACK_API_URL}/subaccount/${encodeURIComponent(existingAccount.rows[0].subaccountCode)}`,
        subaccountPayload,
        { headers, timeout: 10000 }
      )
      : await axios.post(`${PAYSTACK_API_URL}/subaccount`, subaccountPayload, { headers, timeout: 10000 });
    const subaccountCode = subaccountResponse.data.data?.subaccount_code;
    if (!subaccountResponse.data.status || typeof subaccountCode !== 'string' || !subaccountCode) {
      return res.status(502).json({ success: false, error: 'Paystack could not create the seller payout account.' });
    }

    const savedAccount = await pool.query(
      `UPDATE users
       SET paystack_subaccount_code = $1, payout_bank_code = $2, payout_bank_name = $3,
           payout_account_name = $4, payout_account_last4 = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING id`,
      [subaccountCode, bankCode, bankName, accountName, accountNumber.slice(-4), req.user.userId]
    );
    if (savedAccount.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Seller account not found.' });
    }

    return res.json({
      success: true,
      message: 'Paystack payout account verified and saved.',
      account: {
        configured: true,
        bankName,
        accountName,
        accountNumberLast4: accountNumber.slice(-4),
        sellerPayoutPercentage: SELLER_PAYOUT_PERCENTAGE,
      },
    });
  } catch (error) {
    console.error('Paystack payout setup failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(502).json({ success: false, error: 'Paystack could not verify or create the payout account.' });
  }
});

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

    const listingId = parseInt(`${req.params.id}`, 10);
    const { kwhRequested, buyerLatitude, buyerLongitude, buyerDeviceId } = req.body;

    if (!kwhRequested || buyerLatitude === undefined || buyerLongitude === undefined || typeof buyerDeviceId !== 'string' || !buyerDeviceId.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: kwhRequested, buyerLatitude, buyerLongitude, buyerDeviceId',
      });
    }

    const result = await MarketplaceService.createPurchaseIntent({
      buyerId: req.user.userId,
      listingId,
      kwhRequested: parseFloat(kwhRequested),
      buyerLatitude: parseFloat(buyerLatitude),
      buyerLongitude: parseFloat(buyerLongitude),
      buyerDeviceId: buyerDeviceId.trim(),
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
