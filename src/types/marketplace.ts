export type SourceStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'OFFLINE' | 'DECOMMISSIONED';
export type ListingStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'SOLD_OUT' | 'EXPIRED';
export type PurchaseStatus = 'RESERVED' | 'PAYMENT_PENDING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

export interface LocationPoint {
  latitude: number;
  longitude: number;
}

export interface UserLocation extends LocationPoint {
  id?: number;
  userId: number;
  locationSource?: 'GPS' | 'MANUAL' | 'APPROXIMATE';
  updatedAt?: string;
}

export interface EnergySource {
  id: number;
  ownerId: number;
  deviceId: string;
  name: string;
  latitude: number;
  longitude: number;
  serviceRadiusMeters: number;
  status: SourceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EnergyListing {
  id: number;
  energySourceId: number;
  sellerId: number;
  availableKwh: number;
  reservedKwh: number;
  pricePerKwh: number;
  status: ListingStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplacePurchase {
  id: number;
  purchaseReference: string;
  listingId: number;
  buyerId: number;
  sellerId: number;
  deviceId: string;
  distanceMeters: number;
  pricePerKwh: number;
  kwhRequested: number;
  amount: number;
  status: PurchaseStatus;
  paystackReference?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NearbyListingItem {
  listingId: number;
  sourceId: number;
  sourceName: string;
  sellerId: number;
  sellerEmail?: string;
  deviceId: string;
  distanceMeters: number;
  effectiveRadiusMeters: number;
  availableKwh: number;
  pricePerKwh: number;
  status: ListingStatus;
  deviceStatus: 'ONLINE' | 'OFFLINE';
  lastSeenAt?: string;
  sourceLatitude: number;
  sourceLongitude: number;
}
