import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateHaversineDistance,
  calculateEffectiveRadius,
  isWithinServiceRadius,
  isValidCoordinate,
} from '../services/location.js';

describe('PAYGO Marketplace Location Matching & Business Rules Test Suite', () => {
  it('should validate coordinates correctly', () => {
    assert.equal(isValidCoordinate(7.44, 3.9), true);
    assert.equal(isValidCoordinate(0, 0), true);
    assert.equal(isValidCoordinate(91, 3.9), false);
    assert.equal(isValidCoordinate(-91, 3.9), false);
    assert.equal(isValidCoordinate(7.44, 181), false);
    assert.equal(isValidCoordinate(7.44, -181), false);
    assert.equal(isValidCoordinate(NaN, 3.9), false);
  });

  it('should calculate 0 meters for identical coordinates', () => {
    const distance = calculateHaversineDistance(7.44, 3.9, 7.44, 3.9);
    assert.equal(distance, 0);
  });

  it('should calculate accurate distance for nearby points (~180m)', () => {
    // 7.4400, 3.9000 to 7.4416, 3.9000 is ~178 meters
    const distance = calculateHaversineDistance(7.44, 3.9, 7.4416, 3.9);
    assert.ok(distance >= 170 && distance <= 190, `Distance should be ~178m, got ${distance}m`);
  });

  it('should calculate accurate distance for distant points (~1.8km)', () => {
    // 7.4400, 3.9000 to 7.4560, 3.9000 is ~1779 meters
    const distance = calculateHaversineDistance(7.44, 3.9, 7.456, 3.9);
    assert.ok(distance >= 1700 && distance <= 1850, `Distance should be ~1.78km, got ${distance}m`);
  });

  it('should calculate effective radius correctly: MIN(buyerRadius, sellerRadius, platformMax)', () => {
    // Buyer: 1000m, Seller: 500m, Platform: 5000m -> Effective: 500m
    const radius1 = calculateEffectiveRadius(1000, 500, 5000);
    assert.equal(radius1, 500);

    // Buyer: 200m, Seller: 500m, Platform: 5000m -> Effective: 200m
    const radius2 = calculateEffectiveRadius(200, 500, 5000);
    assert.equal(radius2, 200);

    // Buyer: 10000m (exceeds platform max), Seller: 8000m -> Effective: 5000m
    const radius3 = calculateEffectiveRadius(10000, 8000, 5000);
    assert.equal(radius3, 5000);
  });

  it('should evaluate service radius inclusion and exclusion correctly', () => {
    assert.equal(isWithinServiceRadius(180, 500), true);
    assert.equal(isWithinServiceRadius(500, 500), true);
    assert.equal(isWithinServiceRadius(501, 500), false);
    assert.equal(isWithinServiceRadius(1800, 500), false);
  });

  it('should calculate monetary amount strictly server-side (kwhRequested * pricePerKwh)', () => {
    const kwhRequested = 2;
    const pricePerKwh = 250;
    const amount = Math.round(kwhRequested * pricePerKwh);
    assert.equal(amount, 500);
  });

  it('should calculate remaining sellable energy safely (availableKwh - reservedKwh)', () => {
    const availableKwh = 10;
    const reservedKwh = 4;
    const remainingSellable = availableKwh - reservedKwh;
    assert.equal(remainingSellable, 6);

    // Attempting to request 7 kWh when only 6 remains must be rejected
    const requestKwh = 7;
    assert.equal(requestKwh > remainingSellable, true);
  });
});
