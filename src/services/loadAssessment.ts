import pool from '../db.js';

export interface ApplianceSelection {
  applianceId: number;
  quantity: number;
  simultaneousQuantity: number;
  ratedPowerOverrideW?: number;
}

export interface LoadAssessment {
  connectedPowerW: number;
  simultaneousPowerW: number;
  steadyApparentVa: number;
  startingSurgeVa: number;
  requestedPowerW: number;
  requestedApparentVa: number;
  requestedStartingSurgeVa: number;
}

export function calculateLoadAssessment(
  selections: ApplianceSelection[],
  catalogue: Array<{ id: number; rated_power_w: string | number; power_factor: string | number; starting_surge_multiplier: string | number }>,
  safetyMarginPct: number
): LoadAssessment {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('Select at least one appliance before requesting a connection.');
  }
  if (!Number.isFinite(safetyMarginPct) || safetyMarginPct < 0 || safetyMarginPct > 100) {
    throw new Error('The energy source has an invalid safety margin configuration.');
  }

  const byId = new Map(catalogue.map(item => [Number(item.id), item]));
  let connectedPowerW = 0;
  let simultaneousPowerW = 0;
  let steadyApparentVa = 0;
  let startingSurgeVa = 0;
  const seen = new Set<number>();

  for (const selection of selections) {
    const id = Number(selection.applianceId);
    const quantity = Number(selection.quantity);
    const simultaneous = Number(selection.simultaneousQuantity);
    const appliance = byId.get(id);
    if (!appliance || seen.has(id)) throw new Error('One or more selected appliances are invalid or duplicated.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100 ||
        !Number.isInteger(simultaneous) || simultaneous < 1 || simultaneous > quantity) {
      throw new Error('Appliance quantities and simultaneous-use quantities are invalid.');
    }
    const override = selection.ratedPowerOverrideW === undefined ? undefined : Number(selection.ratedPowerOverrideW);
    if (override !== undefined && (!Number.isFinite(override) || override <= 0 || override > 50000)) {
      throw new Error('Custom appliance wattage must be between 1W and 50,000W.');
    }
    const watts = override ?? Number(appliance.rated_power_w);
    const pf = Number(appliance.power_factor);
    const surgeMultiplier = Number(appliance.starting_surge_multiplier);
    if (!(watts > 0) || !(pf > 0 && pf <= 1) || !(surgeMultiplier >= 1)) {
      throw new Error('The appliance catalogue contains an invalid electrical rating.');
    }

    connectedPowerW += watts * quantity;
    simultaneousPowerW += watts * simultaneous;
    const applianceVa = (watts / pf) * simultaneous;
    steadyApparentVa += applianceVa;
    // Conservative estimate: all selected motor/inductive loads may start together.
    startingSurgeVa += applianceVa * surgeMultiplier;
    seen.add(id);
  }

  const margin = 1 + safetyMarginPct / 100;
  return {
    connectedPowerW: round2(connectedPowerW),
    simultaneousPowerW: round2(simultaneousPowerW),
    steadyApparentVa: round2(steadyApparentVa),
    startingSurgeVa: round2(startingSurgeVa),
    requestedPowerW: round2(simultaneousPowerW * margin),
    requestedApparentVa: round2(steadyApparentVa * margin),
    requestedStartingSurgeVa: round2(startingSurgeVa * margin),
  };
}

export async function loadCatalogueSelections(selections: ApplianceSelection[]) {
  const ids = selections.map(item => Number(item.applianceId));
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new Error('Invalid appliance selection.');
  }
  const result = await pool.query(
    `SELECT id, rated_power_w, power_factor, starting_surge_multiplier
     FROM appliance_catalogue WHERE id = ANY($1::bigint[]) AND is_active = TRUE`,
    [ids]
  );
  if (result.rows.length !== new Set(ids).size) {
    throw new Error('One or more selected appliances are no longer available.');
  }
  return result.rows;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
