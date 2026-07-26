import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { determine, expand, PERMITS, CyclicRuleSetError, type Jurisdiction, type ProjectType, type ProjectInput } from "../src/domain/permits.js";

const TYPES: Record<string, ProjectType> = {
  adu: { key: "adu", label: "Accessory dwelling unit", residential: true, structural: true, baseValuation: 165_000 },
  reroof: { key: "reroof", label: "Re-roof", residential: true, structural: false, baseValuation: 24_000 },
  sfr_new: { key: "sfr_new", label: "New single-family dwelling", residential: true, structural: true, baseValuation: 420_000 },
  tenant_improvement: { key: "tenant_improvement", label: "Commercial tenant improvement", residential: false, structural: false, baseValuation: 190_000 },
};

const seattle: Jurisdiction = {
  key: "SEATTLE", name: "Seattle, WA",
  reviewDays: { planning: 42, building: 45, electrical: 14, plumbing: 14, mechanical: 14, fire: 21, row: 30, historic: 60 },
  correctionRounds: 2.6, correctionDays: 18, trades: "separate",
  valuationThresholdEngineered: 50_000, residentialFireSprinkler: true, notes: "",
};

const phoenix: Jurisdiction = {
  key: "PHOENIX", name: "Phoenix, AZ",
  reviewDays: { planning: 15, building: 20, electrical: 7, plumbing: 7, mechanical: 7, fire: 12, row: 14, historic: 30 },
  correctionRounds: 1.2, correctionDays: 9, trades: "bundled",
  valuationThresholdEngineered: 100_000, residentialFireSprinkler: false, notes: "",
};

const baseScope: ProjectInput = {
  type: "adu", valuation: null, changesFootprint: true, changeOfOccupancy: false,
  historicDistrict: false, rowWork: true, electricalWork: true, plumbingWork: true,
  mechanicalWork: true, structuralRoofWork: false,
};

describe("permit sequencing", () => {
  test("planning is scheduled before building, never alongside it", () => {
    const d = determine(baseScope, seattle, TYPES);
    const layerOf = (id: string) => d.schedule.find((s) => s.permits.some((p) => p.id === id))!.layer;

    assert.ok(layerOf("planning") < layerOf("building"), "planning must gate building");
    assert.ok(layerOf("building") < layerOf("electrical"), "trades follow the building permit");
  });

  test("permits in one stage file in parallel, so the stage costs the slowest review", () => {
    const d = determine(baseScope, seattle, TYPES);
    const tradeStage = d.schedule.find((s) => s.permits.some((p) => p.id === "electrical"))!;

    assert.ok(tradeStage.permits.length > 1, "trades should share a stage");
    const slowest = Math.max(...tradeStage.permits.map((p) => seattle.reviewDays[p.discipline]));
    assert.equal(tradeStage.reviewDays, slowest);

    const sumOfAll = tradeStage.permits.reduce((s, p) => s + seattle.reviewDays[p.discipline], 0);
    assert.ok(tradeStage.reviewDays < sumOfAll, "parallel stage must not be charged the sum");
  });

  test("bundled-trade jurisdictions drop the separate trade permits", () => {
    const separate = determine(baseScope, seattle, TYPES).required.map((p) => p.id);
    const bundled = determine(baseScope, phoenix, TYPES).required.map((p) => p.id);

    assert.ok(separate.includes("electrical"));
    assert.ok(!bundled.includes("electrical"), "Phoenix bundles trades into the building permit");
    assert.ok(bundled.includes("building"));
  });

  test("historic district inserts a review that gates the building permit", () => {
    const without = determine(baseScope, seattle, TYPES);
    const withHistoric = determine({ ...baseScope, historicDistrict: true }, seattle, TYPES);

    assert.ok(!without.required.some((p) => p.id === "historic"));
    assert.ok(withHistoric.required.some((p) => p.id === "historic"));
    assert.ok(withHistoric.totalDays > without.totalDays, "historic review must extend the timeline");
  });

  test("total days is the sum of stage durations including corrections", () => {
    const d = determine(baseScope, seattle, TYPES);
    const expected = d.schedule.reduce((s, st) => s + st.layerDays, 0);

    assert.equal(d.totalDays, expected);
    assert.equal(d.schedule.at(-1)!.cumulative, d.totalDays);

    for (const st of d.schedule) {
      assert.equal(st.layerDays, st.reviewDays + st.correctionDays);
    }
  });

  test("every required permit lands in exactly one stage", () => {
    const d = determine(baseScope, seattle, TYPES);
    const scheduled = d.schedule.flatMap((s) => s.permits.map((p) => p.id));

    assert.equal(scheduled.length, d.required.length);
    assert.equal(new Set(scheduled).size, scheduled.length, "no permit may appear twice");
  });

  test("required and not-required partition the whole rule set", () => {
    const d = determine(baseScope, seattle, TYPES);
    assert.equal(d.required.length + d.notRequired.length, PERMITS.length);
  });

  test("a re-roof with no structural work needs no building permit", () => {
    const scope: ProjectInput = {
      ...baseScope, type: "reroof", changesFootprint: false, rowWork: false,
      electricalWork: false, plumbingWork: false, mechanicalWork: false, structuralRoofWork: false,
    };
    const d = determine(scope, seattle, TYPES);
    assert.ok(!d.required.some((p) => p.id === "building"));
  });

  test("commercial work always draws fire review", () => {
    const d = determine({ ...baseScope, type: "tenant_improvement" }, phoenix, TYPES);
    assert.ok(d.required.some((p) => p.id === "fire"));
  });
});

describe("jurisdiction escalations", () => {
  test("valuation at or above the threshold requires engineered drawings", () => {
    const under = determine({ ...baseScope, valuation: 40_000 }, seattle, TYPES);
    const over = determine({ ...baseScope, valuation: 165_000 }, seattle, TYPES);

    assert.ok(!under.flags.some((f) => /engineered/i.test(f)));
    assert.ok(over.flags.some((f) => /engineered/i.test(f)));
  });

  test("Seattle requires sprinklers on a new dwelling, Phoenix does not", () => {
    const sea = determine({ ...baseScope, type: "sfr_new" }, seattle, TYPES);
    const phx = determine({ ...baseScope, type: "sfr_new" }, phoenix, TYPES);

    assert.ok(sea.flags.some((f) => /sprinkler/i.test(f)));
    assert.ok(!phx.flags.some((f) => /sprinkler/i.test(f)));
  });

  test("change of occupancy triggers a current-code accessibility review", () => {
    const d = determine({ ...baseScope, changeOfOccupancy: true }, seattle, TYPES);
    assert.ok(d.flags.some((f) => /accessibility/i.test(f)));
  });
});

describe("input handling", () => {
  test("valuation defaults to the project type baseline", () => {
    const p = expand({ ...baseScope, valuation: null }, TYPES);
    assert.equal(p.valuation, TYPES.adu!.baseValuation);
  });

  test("an unknown project type is rejected rather than silently defaulted", () => {
    assert.throws(() => expand({ ...baseScope, type: "space_elevator" }, TYPES), /unknown project type/);
  });

  test("a cyclic rule set raises instead of dropping permits", () => {
    // Guard the guard: if two rules ever require each other, the layering loop
    // must fail loudly rather than return a short, plausible-looking schedule.
    const a = PERMITS.find((p) => p.id === "planning")!;
    const original = a.after;
    a.after = ["building"]; // planning now waits on building, which waits on planning
    try {
      assert.throws(() => determine(baseScope, seattle, TYPES), CyclicRuleSetError);
    } finally {
      a.after = original;
    }
  });
});
