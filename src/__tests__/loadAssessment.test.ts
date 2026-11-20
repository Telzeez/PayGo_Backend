import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateLoadAssessment } from '../services/loadAssessment.js';

const catalogue = [
  { id: 1, rated_power_w: 10, power_factor: 0.9, starting_surge_multiplier: 1 },
  { id: 2, rated_power_w: 200, power_factor: 0.8, starting_surge_multiplier: 3 },
];

describe('PAYGO customer load assessment', () => {
  it('calculates simultaneous load, apparent power and conservative starting surge with margin', () => {
    const result = calculateLoadAssessment([
      { applianceId: 1, quantity: 4, simultaneousQuantity: 4 },
      { applianceId: 2, quantity: 1, simultaneousQuantity: 1 },
    ], catalogue, 20);

    assert.equal(result.connectedPowerW, 240);
    assert.equal(result.simultaneousPowerW, 240);
    assert.equal(result.requestedPowerW, 288);
    assert.equal(result.requestedApparentVa, 353.33);
    assert.equal(result.requestedStartingSurgeVa, 953.33);
  });

  it('uses simultaneous quantity for demand, not the full installed quantity', () => {
    const result = calculateLoadAssessment([
      { applianceId: 1, quantity: 5, simultaneousQuantity: 2 },
    ], catalogue, 0);

    assert.equal(result.connectedPowerW, 50);
    assert.equal(result.simultaneousPowerW, 20);
    assert.equal(result.requestedPowerW, 20);
  });

  it('allows a customer to override catalogue wattage with the appliance nameplate rating', () => {
    const result = calculateLoadAssessment([
      { applianceId: 1, quantity: 2, simultaneousQuantity: 2, ratedPowerOverrideW: 18 },
    ], catalogue, 0);

    assert.equal(result.connectedPowerW, 36);
    assert.equal(result.requestedPowerW, 36);
  });

  it('rejects invalid simultaneous quantities and duplicate appliance rows', () => {
    assert.throws(() => calculateLoadAssessment([
      { applianceId: 1, quantity: 1, simultaneousQuantity: 2 },
    ], catalogue, 0));
    assert.throws(() => calculateLoadAssessment([
      { applianceId: 1, quantity: 1, simultaneousQuantity: 1 },
      { applianceId: 1, quantity: 2, simultaneousQuantity: 1 },
    ], catalogue, 0));
  });

  it('rejects invalid safety margins', () => {
    assert.throws(() => calculateLoadAssessment([
      { applianceId: 1, quantity: 1, simultaneousQuantity: 1 },
    ], catalogue, 101));
  });
});
