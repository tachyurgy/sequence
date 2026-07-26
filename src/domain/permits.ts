// Permit requirement determination and review sequencing.
//
// The expensive failure in permitting is order, not rejection: a package filed
// before its prerequisite has cleared loses weeks that no amount of expediting
// recovers. So the rule set is a graph, not a checklist, and the output is a
// topological layering that says what can be filed in parallel.

export type Discipline =
  | "planning" | "historic" | "building" | "row"
  | "electrical" | "plumbing" | "mechanical" | "fire";

export interface Jurisdiction {
  key: string;
  name: string;
  reviewDays: Record<Discipline, number>;
  correctionRounds: number;
  correctionDays: number;
  trades: "separate" | "bundled";
  valuationThresholdEngineered: number;
  residentialFireSprinkler: boolean;
  highVelocityHurricaneZone?: boolean;
  notes: string;
}

export interface ProjectInput {
  type: string;
  valuation?: number | null;
  changesFootprint: boolean;
  changeOfOccupancy: boolean;
  historicDistrict: boolean;
  rowWork: boolean;
  electricalWork: boolean;
  plumbingWork: boolean;
  mechanicalWork: boolean;
  structuralRoofWork: boolean;
}

export interface Project extends ProjectInput {
  residential: boolean;
  valuation: number;
  label: string;
}

export interface ProjectType {
  key: string;
  label: string;
  residential: boolean;
  structural: boolean;
  baseValuation: number;
}

export interface PermitRule {
  id: string;
  name: string;
  discipline: Discipline;
  after: string[];
  required: (p: Project, j: Jurisdiction) => boolean;
  why: string;
}

export const PERMITS: PermitRule[] = [
  {
    id: "planning", name: "Planning / zoning review", discipline: "planning", after: [],
    required: (p) => p.type === "adu" || p.type === "sfr_new" || p.changesFootprint || p.changeOfOccupancy,
    why: "Any change to footprint, use or density is reviewed for zoning compliance before the building permit can be issued.",
  },
  {
    id: "historic", name: "Historic / design review", discipline: "historic", after: [],
    required: (p) => p.historicDistrict,
    why: "Exterior work in a historic district requires a certificate of appropriateness before permitting.",
  },
  {
    id: "building", name: "Building permit", discipline: "building", after: ["planning", "historic"],
    required: (p) => p.type !== "reroof" || p.structuralRoofWork,
    why: "The primary permit. Cannot be issued while land-use or historic review is outstanding.",
  },
  {
    id: "row", name: "Right-of-way / encroachment", discipline: "row", after: ["planning"],
    required: (p) => p.rowWork,
    why: "Any work in the public right of way, sidewalk, curb cut or utility tap, is a separate encroachment permit.",
  },
  {
    id: "electrical", name: "Electrical permit", discipline: "electrical", after: ["building"],
    required: (p, j) => p.electricalWork && j.trades === "separate",
    why: "Filed separately in this jurisdiction and inspected on its own schedule.",
  },
  {
    id: "plumbing", name: "Plumbing permit", discipline: "plumbing", after: ["building"],
    required: (p, j) => p.plumbingWork && j.trades === "separate",
    why: "Filed separately in this jurisdiction.",
  },
  {
    id: "mechanical", name: "Mechanical permit", discipline: "mechanical", after: ["building"],
    required: (p, j) => p.mechanicalWork && j.trades === "separate",
    why: "Covers HVAC, exhaust and gas appliance work.",
  },
  {
    id: "fire", name: "Fire department review", discipline: "fire", after: ["building"],
    required: (p, j) =>
      !p.residential || p.type === "restaurant_buildout" || (j.residentialFireSprinkler && p.type === "sfr_new"),
    why: "Commercial occupancies and sprinklered residences require fire review of egress, suppression and alarm.",
  },
];

export interface Stage {
  layer: number;
  permits: PermitRule[];
  reviewDays: number;
  correctionDays: number;
  layerDays: number;
  cumulative: number;
}

export interface Determination {
  jurisdiction: Jurisdiction;
  project: Project;
  required: PermitRule[];
  notRequired: PermitRule[];
  schedule: Stage[];
  totalDays: number;
  flags: string[];
}

export class CyclicRuleSetError extends Error {
  constructor(remaining: string[]) {
    super(`permit rules contain a cycle; could not place: ${remaining.join(", ")}`);
    this.name = "CyclicRuleSetError";
  }
}

export function expand(input: ProjectInput, types: Record<string, ProjectType>): Project {
  const t = types[input.type];
  if (!t) throw new Error(`unknown project type: ${input.type}`);
  return {
    ...input,
    residential: t.residential,
    valuation: input.valuation ?? t.baseValuation,
    label: t.label,
  };
}

export function determine(
  input: ProjectInput,
  jurisdiction: Jurisdiction,
  types: Record<string, ProjectType>,
): Determination {
  const project = expand(input, types);

  const required = PERMITS.filter((p) => p.required(project, jurisdiction));
  const requiredIds = new Set(required.map((r) => r.id));
  const notRequired = PERMITS.filter((p) => !requiredIds.has(p.id));

  // Topological layering. A permit lands in the earliest layer where every one of
  // its required predecessors has already been placed; everything sharing a layer
  // can be filed simultaneously, which is the actual scheduling win.
  const layers: PermitRule[][] = [];
  const placed = new Set<string>();
  let remaining = [...required];

  while (remaining.length) {
    const ready = remaining.filter((perm) =>
      perm.after.filter((a) => requiredIds.has(a)).every((a) => placed.has(a)),
    );
    // A rule set that cannot progress is a bug in the rules, not a project that
    // needs no permits. Failing loudly beats silently dropping requirements.
    if (!ready.length) throw new CyclicRuleSetError(remaining.map((r) => r.id));

    layers.push(ready);
    ready.forEach((r) => placed.add(r.id));
    remaining = remaining.filter((r) => !placed.has(r.id));
  }

  let days = 0;
  const schedule: Stage[] = layers.map((layer, i) => {
    const reviewDays = Math.max(...layer.map((p) => jurisdiction.reviewDays[p.discipline] ?? 14));
    const correctionDays = Math.round(jurisdiction.correctionRounds * jurisdiction.correctionDays);
    const layerDays = reviewDays + correctionDays;
    days += layerDays;
    return { layer: i + 1, permits: layer, reviewDays, correctionDays, layerDays, cumulative: days };
  });

  const flags: string[] = [];
  if (project.valuation >= jurisdiction.valuationThresholdEngineered) {
    flags.push(
      `Valuation ${money(project.valuation)} is at or above the ${money(jurisdiction.valuationThresholdEngineered)} threshold, so engineered, sealed drawings are required.`,
    );
  }
  if (jurisdiction.highVelocityHurricaneZone && ["sfr_new", "reroof", "adu"].includes(project.type)) {
    flags.push(
      "High-Velocity Hurricane Zone: a Notice of Acceptance is required for every exterior opening and the roof assembly. Missing NOAs are the most common rejection here.",
    );
  }
  if (jurisdiction.residentialFireSprinkler && project.type === "sfr_new") {
    flags.push("Residential fire sprinklers are required in new one- and two-family dwellings in this jurisdiction.");
  }
  if (project.historicDistrict) {
    flags.push("Historic review runs before building review and cannot be filed in parallel with it.");
  }
  if (project.changeOfOccupancy) {
    flags.push(
      "Change of occupancy triggers a full accessibility and egress review against current code, not the code the building was built to.",
    );
  }

  return { jurisdiction, project, required, notRequired, schedule, totalDays: days, flags };
}

export function money(n: number): string {
  return "$" + n.toLocaleString("en-US");
}
