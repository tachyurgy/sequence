// Postgres access. Jurisdictions and project types are reference data that
// changes without a deploy, which is exactly why they belong in the database
// rather than in a constant: a jurisdiction that changes its review times or
// starts bundling trade permits should be a row update, not a release.

import pg from "pg";
import type { Jurisdiction, ProjectType, Discipline } from "./domain/permits.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jurisdictions (
      key                             TEXT PRIMARY KEY,
      name                            TEXT NOT NULL,
      review_days                     JSONB NOT NULL,
      correction_rounds               REAL NOT NULL,
      correction_days                 INTEGER NOT NULL,
      trades                          TEXT NOT NULL CHECK (trades IN ('separate','bundled')),
      valuation_threshold_engineered  INTEGER NOT NULL,
      residential_fire_sprinkler      BOOLEAN NOT NULL DEFAULT FALSE,
      hvhz                            BOOLEAN NOT NULL DEFAULT FALSE,
      notes                           TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS project_types (
      key             TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      residential     BOOLEAN NOT NULL,
      structural      BOOLEAN NOT NULL,
      base_valuation  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS determinations (
      id              BIGSERIAL PRIMARY KEY,
      jurisdiction    TEXT NOT NULL REFERENCES jurisdictions(key),
      project_type    TEXT NOT NULL REFERENCES project_types(key),
      scope           JSONB NOT NULL,
      permit_ids      TEXT[] NOT NULL,
      total_days      INTEGER NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS determinations_created_idx ON determinations (created_at DESC);
  `);
}

const REVIEW = (d: Record<Discipline, number>) => d;

const JURISDICTIONS: Jurisdiction[] = [
  {
    key: "AUSTIN", name: "Austin, TX",
    reviewDays: REVIEW({ planning: 21, building: 28, electrical: 10, plumbing: 10, mechanical: 10, fire: 14, row: 18, historic: 35 }),
    correctionRounds: 1.8, correctionDays: 12, trades: "separate",
    valuationThresholdEngineered: 75_000, residentialFireSprinkler: false,
    notes: "Trade permits are separate applications. Commercial work over $75k requires engineered drawings.",
  },
  {
    key: "PHOENIX", name: "Phoenix, AZ",
    reviewDays: REVIEW({ planning: 15, building: 20, electrical: 7, plumbing: 7, mechanical: 7, fire: 12, row: 14, historic: 30 }),
    correctionRounds: 1.2, correctionDays: 9, trades: "bundled",
    valuationThresholdEngineered: 100_000, residentialFireSprinkler: false,
    notes: "Trade permits are bundled into the building permit for most residential scopes.",
  },
  {
    key: "SEATTLE", name: "Seattle, WA",
    reviewDays: REVIEW({ planning: 42, building: 45, electrical: 14, plumbing: 14, mechanical: 14, fire: 21, row: 30, historic: 60 }),
    correctionRounds: 2.6, correctionDays: 18, trades: "separate",
    valuationThresholdEngineered: 50_000, residentialFireSprinkler: true,
    notes: "Land use review runs before building. Residential sprinklers required in new one- and two-family dwellings.",
  },
  {
    key: "MIAMI_DADE", name: "Miami-Dade County, FL",
    reviewDays: REVIEW({ planning: 25, building: 32, electrical: 12, plumbing: 12, mechanical: 12, fire: 18, row: 22, historic: 45 }),
    correctionRounds: 2.2, correctionDays: 15, trades: "separate",
    valuationThresholdEngineered: 60_000, residentialFireSprinkler: false, highVelocityHurricaneZone: true,
    notes: "High-Velocity Hurricane Zone: product approval (NOA) required for every exterior opening and roof assembly.",
  },
];

const PROJECT_TYPES: ProjectType[] = [
  { key: "kitchen_remodel", label: "Kitchen remodel", residential: true, structural: false, baseValuation: 48_000 },
  { key: "bathroom_addition", label: "Bathroom addition", residential: true, structural: true, baseValuation: 32_000 },
  { key: "adu", label: "Accessory dwelling unit", residential: true, structural: true, baseValuation: 165_000 },
  { key: "sfr_new", label: "New single-family dwelling", residential: true, structural: true, baseValuation: 420_000 },
  { key: "tenant_improvement", label: "Commercial tenant improvement", residential: false, structural: false, baseValuation: 190_000 },
  { key: "restaurant_buildout", label: "Restaurant build-out", residential: false, structural: false, baseValuation: 340_000 },
  { key: "reroof", label: "Re-roof", residential: true, structural: false, baseValuation: 24_000 },
  { key: "solar_pv", label: "Rooftop solar PV", residential: true, structural: true, baseValuation: 28_000 },
];

export async function seed(): Promise<void> {
  for (const j of JURISDICTIONS) {
    await pool.query(
      `INSERT INTO jurisdictions
         (key,name,review_days,correction_rounds,correction_days,trades,
          valuation_threshold_engineered,residential_fire_sprinkler,hvhz,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (key) DO UPDATE SET
         name=EXCLUDED.name, review_days=EXCLUDED.review_days,
         correction_rounds=EXCLUDED.correction_rounds, correction_days=EXCLUDED.correction_days,
         trades=EXCLUDED.trades, valuation_threshold_engineered=EXCLUDED.valuation_threshold_engineered,
         residential_fire_sprinkler=EXCLUDED.residential_fire_sprinkler, hvhz=EXCLUDED.hvhz, notes=EXCLUDED.notes`,
      [j.key, j.name, JSON.stringify(j.reviewDays), j.correctionRounds, j.correctionDays, j.trades,
       j.valuationThresholdEngineered, j.residentialFireSprinkler, j.highVelocityHurricaneZone ?? false, j.notes],
    );
  }
  for (const t of PROJECT_TYPES) {
    await pool.query(
      `INSERT INTO project_types (key,label,residential,structural,base_valuation)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (key) DO UPDATE SET
         label=EXCLUDED.label, residential=EXCLUDED.residential,
         structural=EXCLUDED.structural, base_valuation=EXCLUDED.base_valuation`,
      [t.key, t.label, t.residential, t.structural, t.baseValuation],
    );
  }
}

export async function loadJurisdictions(): Promise<Record<string, Jurisdiction>> {
  const { rows } = await pool.query("SELECT * FROM jurisdictions ORDER BY name");
  const out: Record<string, Jurisdiction> = {};
  for (const r of rows) {
    out[r.key] = {
      key: r.key, name: r.name, reviewDays: r.review_days,
      correctionRounds: Number(r.correction_rounds), correctionDays: r.correction_days,
      trades: r.trades, valuationThresholdEngineered: r.valuation_threshold_engineered,
      residentialFireSprinkler: r.residential_fire_sprinkler,
      highVelocityHurricaneZone: r.hvhz, notes: r.notes,
    };
  }
  return out;
}

export async function loadProjectTypes(): Promise<Record<string, ProjectType>> {
  const { rows } = await pool.query("SELECT * FROM project_types ORDER BY base_valuation");
  const out: Record<string, ProjectType> = {};
  for (const r of rows) {
    out[r.key] = {
      key: r.key, label: r.label, residential: r.residential,
      structural: r.structural, baseValuation: r.base_valuation,
    };
  }
  return out;
}

export async function recordDetermination(
  jurisdiction: string, projectType: string, scope: unknown, permitIds: string[], totalDays: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO determinations (jurisdiction, project_type, scope, permit_ids, total_days)
     VALUES ($1,$2,$3,$4,$5)`,
    [jurisdiction, projectType, JSON.stringify(scope), permitIds, totalDays],
  );
}

export async function recentDeterminations(limit = 8) {
  const { rows } = await pool.query(
    `SELECT d.jurisdiction, j.name AS jurisdiction_name, d.project_type, t.label AS project_label,
            array_length(d.permit_ids, 1) AS permit_count, d.total_days, d.created_at
       FROM determinations d
       JOIN jurisdictions j ON j.key = d.jurisdiction
       JOIN project_types t ON t.key = d.project_type
      ORDER BY d.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
