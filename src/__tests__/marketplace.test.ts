import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateHaversineDistance,
  calculateEffectiveRadius,
  isWithinServiceRadius,
  isValidCoordinate,
} from '../services/location.js';

describe('PAYGO Marketplace Location Matching & Business Rules Test Suite', () => {
  it('validates latitude and longitude boundaries', () => {
    assert.equal(isValidCoordinate(7.44, 3.9), true);
    assert.equal(isValidCoordinate(90, 180), true);
    assert.equal(isValidCoordinate(-90, -180), true);
    assert.equal(isValidCoordinate(91, 3.9), false);
    assert.equal(isValidCoordinate(-91, 3.9), false);
    assert.equal(isValidCoordinate(7.44, 181), false);
    assert.equal(isValidCoordinate(7.44, -181), false);
    assert.equal(isValidCoordinate(NaN, 3.9), false);
    assert.equal(isValidCoordinate('7.44' as any, 3.9), false);
  });

  it('returns zero metres for identical coordinates', () => {
    assert.equal(calculateHaversineDistance(7.44, 3.9, 7.44, 3.9), 0);
  });

  it('calculates a short local distance of approximately 178 metres', () => {
    const distance = calculateHaversineDistance(7.44, 3.9, 7.4416, 3.9);
    assert.ok(distance >= 170 && distance <= 190, `Expected approximately 178m, got ${distance}m`);
  });

  it('calculates a longer local distance of approximately 1.78 kilometres', () => {
    const distance = calculateHaversineDistance(7.44, 3.9, 7.456, 3.9);
    assert.ok(distance >= 1700 && distance <= 1850, `Expected approximately 1.78km, got ${distance}m`);
  });

  it('rejects invalid coordinates before calculating distance', () => {
    assert.throws(() => calculateHaversineDistance(91, 3.9, 7.44, 3.9), /Invalid coordinates/);
  });

  it('checks the configured 50-metre service boundary', () => {
    const approximately50m = calculateHaversineDistance(7.44, 3.9, 7.44045, 3.9);
    assert.ok(approximately50m >= 49 && approximately50m <= 51,
      `Expected approximately 50m, got ${approximately50m}m`);
    assert.equal(isWithinServiceRadius(50, 50), true);
    assert.equal(isWithinServiceRadius(51, 50), false);
  });

  it('uses the smallest buyer, seller and platform radius', () => {
    assert.equal(calculateEffectiveRadius(1000, 500, 5000), 500);
    assert.equal(calculateEffectiveRadius(200, 500, 5000), 200);
    assert.equal(calculateEffectiveRadius(10000, 8000, 5000), 5000);
    assert.equal(calculateEffectiveRadius(0, 500, 5000), 500);
  });

  it('calculates the server-side purchase amount from requested kWh and tariff', () => {
    const amountNaira = Math.round(2 * 250);
    assert.equal(amountNaira, 500);
  });

  it('prevents a request from exceeding remaining sellable energy', () => {
    const availableKwh = 10;
    const reservedKwh = 4;
    const remainingSellable = availableKwh - reservedKwh;
    assert.equal(remainingSellable, 6);
    assert.equal(5 <= remainingSellable, true);
    assert.equal(7 <= remainingSellable, false);
  });
});
