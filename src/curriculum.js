// ============================================================
// CURRICULUM — sub-strand definitions per operation.
//
// Replaces the old "level 1-12 max(a,b)" difficulty system with
// pedagogically-ordered families. Each strand:
//   id          — stable key, persisted on fact rows
//   label       — short human-facing name
//   description — one-line strategy hint
//   members(f)  — predicate: does this fact belong here?
//
// Membership is determined by walking strands IN ORDER and taking
// the first match. So a fact like 2+2 lands in "doubles" only
// because "plus-0-1" doesn't match it; if you swap order, you
// change membership.
//
// Unlock rule: a strand "completes" when >=75% of its facts are at
// state `known` or `automatic`. The next strand auto-unlocks the
// moment that threshold is hit. See engine.js strand helpers.
//
// 2-digit strands generate a curated sample of facts rather than
// the full combinatorial space (which would explode into thousands).
// Each 2-digit strand is ~20-25 facts.
// ============================================================

// ---------- ADDITION ----------
// All single-digit strands cap operand size at 12. Without that cap
// a fact like 99+9 would match "plus-9" instead of routing to the
// "Two-digit + one-digit (with carry)" strand where it belongs.
const SD_ADD = (f) => Math.max(f.a, f.b) <= 12;
const ADDITION_STRANDS = [
  {
    id: "add-plus-0-1",
    label: "Plus 0 & Plus 1",
    description: "Count on",
    members: (f) => SD_ADD(f) && (f.a <= 1 || f.b <= 1),
  },
  {
    id: "add-doubles",
    label: "Doubles",
    description: "n + n",
    members: (f) => SD_ADD(f) && f.a === f.b,
  },
  {
    id: "add-plus-10",
    label: "Plus 10",
    description: "Just add a 1 in the tens place",
    members: (f) => SD_ADD(f) && (f.a === 10 || f.b === 10),
  },
  {
    id: "add-plus-9",
    label: "Plus 9",
    description: "Add 10, subtract 1",
    members: (f) => SD_ADD(f) && (f.a === 9 || f.b === 9),
  },
  {
    id: "add-near-doubles",
    label: "Near doubles",
    description: "Use the double + 1",
    members: (f) => SD_ADD(f) && Math.abs(f.a - f.b) === 1,
  },
  {
    id: "add-make-10",
    label: "Make 10",
    description: "Partners that sum to 10",
    members: (f) => SD_ADD(f) && f.a + f.b === 10,
  },
  {
    id: "add-bridge-10",
    label: "Bridge 10",
    description: "Break apart through 10",
    members: (f) => SD_ADD(f) && f.a + f.b > 10,
  },
  {
    id: "add-remaining-12",
    label: "Remaining 0-12",
    description: "Everything else up to 12 + 12",
    members: (f) => SD_ADD(f),
  },
  {
    id: "add-2d-1d-no-carry",
    label: "Two-digit + one-digit (no carry)",
    description: "Place value, no regrouping",
    members: (f) =>
      ((f.a >= 11 && f.a <= 99 && f.b >= 1 && f.b <= 9) ||
        (f.b >= 11 && f.b <= 99 && f.a >= 1 && f.a <= 9)) &&
      (f.a % 10) + (f.b % 10) < 10,
  },
  {
    id: "add-2d-1d-carry",
    label: "Two-digit + one-digit (with carry)",
    description: "Bridging across tens",
    members: (f) =>
      ((f.a >= 11 && f.a <= 99 && f.b >= 1 && f.b <= 9) ||
        (f.b >= 11 && f.b <= 99 && f.a >= 1 && f.a <= 9)) &&
      (f.a % 10) + (f.b % 10) >= 10,
  },
  {
    id: "add-2d-2d-no-carry",
    label: "Two-digit + two-digit (no carry)",
    description: "Column addition",
    members: (f) =>
      f.a >= 10 && f.a <= 99 && f.b >= 10 && f.b <= 99 &&
      (f.a % 10) + (f.b % 10) < 10,
  },
  {
    id: "add-2d-2d-carry",
    label: "Two-digit + two-digit (with carry)",
    description: "Full algorithm",
    members: (f) =>
      f.a >= 10 && f.a <= 99 && f.b >= 10 && f.b <= 99 &&
      (f.a % 10) + (f.b % 10) >= 10,
  },
];

// ---------- SUBTRACTION ----------
// All facts honor a >= b (the existing buildSubtraction invariant).
// Single-digit strands gated by a<=12 so 2-digit facts route correctly.
const SD_SUB = (f) => f.a <= 12;
const SUBTRACTION_STRANDS = [
  {
    id: "sub-minus-0-1",
    label: "Minus 0 & Minus 1",
    description: "Take away 0 or 1",
    members: (f) => SD_SUB(f) && f.b <= 1,
  },
  {
    id: "sub-halve-doubles",
    label: "Halve a double",
    description: "10 − 5, 8 − 4, 12 − 6",
    members: (f) => SD_SUB(f) && f.b * 2 === f.a,
  },
  {
    id: "sub-minus-10",
    label: "Minus 10",
    description: "Drop the tens",
    members: (f) => SD_SUB(f) && f.b === 10,
  },
  {
    id: "sub-from-10",
    label: "Subtract from 10",
    description: "Partners-to-10",
    members: (f) => SD_SUB(f) && f.a === 10,
  },
  {
    id: "sub-back-3",
    label: "Count back ≤ 3",
    description: "Two or three back",
    members: (f) => SD_SUB(f) && (f.b === 2 || f.b === 3),
  },
  {
    id: "sub-from-teens",
    label: "Subtract from teens",
    description: "Use a known +/−10 partner",
    members: (f) => SD_SUB(f) && f.a >= 11,
  },
  {
    id: "sub-remaining-12",
    label: "Remaining 0-12",
    description: "Everything else within 0-12",
    members: (f) => SD_SUB(f),
  },
  {
    id: "sub-2d-1d-no-borrow",
    label: "Two-digit − one-digit (no borrow)",
    description: "Place value, no regrouping",
    members: (f) =>
      f.a >= 11 && f.a <= 99 && f.b >= 1 && f.b <= 9 &&
      (f.a % 10) >= f.b,
  },
  {
    id: "sub-2d-1d-borrow",
    label: "Two-digit − one-digit (with borrow)",
    description: "Borrow from the tens",
    members: (f) =>
      f.a >= 11 && f.a <= 99 && f.b >= 1 && f.b <= 9 &&
      (f.a % 10) < f.b,
  },
  {
    id: "sub-2d-2d-no-borrow",
    label: "Two-digit − two-digit (no borrow)",
    description: "Column subtraction",
    members: (f) =>
      f.a >= 10 && f.a <= 99 && f.b >= 10 && f.b <= 99 &&
      (f.a % 10) >= (f.b % 10),
  },
  {
    id: "sub-2d-2d-borrow",
    label: "Two-digit − two-digit (with borrow)",
    description: "Full algorithm",
    members: (f) =>
      f.a >= 10 && f.a <= 99 && f.b >= 10 && f.b <= 99 &&
      (f.a % 10) < (f.b % 10),
  },
];

// ---------- MULTIPLICATION ----------
// Single-digit (or rather single-table) strands gated by both
// operands <=12 so 2-digit facts route to the 2-digit strands.
const SD_MUL = (f) => f.a <= 12 && f.b <= 12;
const MULTIPLICATION_STRANDS = [
  {
    id: "mul-x0-x1",
    label: "×0 & ×1",
    description: "Identity",
    members: (f) => SD_MUL(f) && (f.a <= 1 || f.b <= 1),
  },
  {
    id: "mul-x10",
    label: "×10",
    description: "Tack on a zero",
    members: (f) => SD_MUL(f) && (f.a === 10 || f.b === 10),
  },
  {
    id: "mul-x2",
    label: "×2 (doubles)",
    description: "Add it to itself",
    members: (f) => SD_MUL(f) && (f.a === 2 || f.b === 2),
  },
  {
    id: "mul-x5",
    label: "×5",
    description: "Half of ×10",
    members: (f) => SD_MUL(f) && (f.a === 5 || f.b === 5),
  },
  {
    id: "mul-squares",
    label: "Squares",
    description: "n × n",
    members: (f) => SD_MUL(f) && f.a === f.b,
  },
  {
    id: "mul-x9",
    label: "×9",
    description: "Use ×10 − x",
    members: (f) => SD_MUL(f) && (f.a === 9 || f.b === 9),
  },
  {
    id: "mul-x3",
    label: "×3",
    description: "Double + one more group",
    members: (f) => SD_MUL(f) && (f.a === 3 || f.b === 3),
  },
  {
    id: "mul-x4",
    label: "×4",
    description: "Double-double",
    members: (f) => SD_MUL(f) && (f.a === 4 || f.b === 4),
  },
  {
    id: "mul-x6",
    label: "×6",
    description: "Double of ×3",
    members: (f) => SD_MUL(f) && (f.a === 6 || f.b === 6),
  },
  {
    id: "mul-x7",
    label: "×7",
    description: "The hardest table — memorize",
    members: (f) => SD_MUL(f) && (f.a === 7 || f.b === 7),
  },
  {
    id: "mul-x8",
    label: "×8",
    description: "Double-double-double",
    members: (f) => SD_MUL(f) && (f.a === 8 || f.b === 8),
  },
  {
    id: "mul-x11-x12",
    label: "×11 & ×12",
    description: "Bigger tables",
    members: (f) => SD_MUL(f) && (f.a === 11 || f.b === 11 || f.a === 12 || f.b === 12),
  },
  {
    id: "mul-2d-1d",
    label: "Two-digit × one-digit",
    description: "Distributive (e.g., 14 × 3 = 30 + 12)",
    members: (f) =>
      ((f.a >= 13 && f.a <= 99 && f.b >= 2 && f.b <= 9) ||
        (f.b >= 13 && f.b <= 99 && f.a >= 2 && f.a <= 9)),
  },
  {
    id: "mul-2d-2d",
    label: "Two-digit × two-digit",
    description: "Standard algorithm",
    members: (f) => f.a >= 11 && f.a <= 99 && f.b >= 11 && f.b <= 99,
  },
];

// ---------- DIVISION ----------
// Basic strands gated by `a <= 144` (max single-digit × single-digit
// product) so multi-digit dividend facts route to the multi-digit
// strands instead of being claimed by ÷3/÷6/etc.
const SD_DIV = (f) => f.a <= 144 && f.b <= 12;
const DIVISION_STRANDS = [
  {
    id: "div-by-1-self",
    label: "÷1 and ÷ itself",
    description: "Trivial identity",
    members: (f) => SD_DIV(f) && (f.b === 1 || f.a === f.b),
  },
  {
    id: "div-by-10",
    label: "÷10",
    description: "Drop the zero",
    members: (f) => SD_DIV(f) && f.b === 10,
  },
  {
    id: "div-by-2",
    label: "÷2",
    description: "Half",
    members: (f) => SD_DIV(f) && f.b === 2,
  },
  {
    id: "div-by-5",
    label: "÷5",
    description: "Half of ÷10 (or count by 5s)",
    members: (f) => SD_DIV(f) && f.b === 5,
  },
  {
    id: "div-squares",
    label: "Squares ÷ root",
    description: "Reverse a square",
    members: (f) => SD_DIV(f) && f.b * f.b === f.a,
  },
  {
    id: "div-by-9",
    label: "÷9",
    description: "Think × 9",
    members: (f) => SD_DIV(f) && f.b === 9,
  },
  {
    id: "div-by-3-4",
    label: "÷3 and ÷4",
    description: "Think × 3 / × 4",
    members: (f) => SD_DIV(f) && (f.b === 3 || f.b === 4),
  },
  {
    id: "div-by-6-7-8",
    label: "÷6, ÷7, ÷8",
    description: "The trickier inverses",
    members: (f) => SD_DIV(f) && (f.b === 6 || f.b === 7 || f.b === 8),
  },
  {
    id: "div-by-11-12",
    label: "÷11 and ÷12",
    description: "Larger divisors",
    members: (f) => SD_DIV(f) && (f.b === 11 || f.b === 12),
  },
  {
    id: "div-2d-1d",
    label: "Multi-digit ÷ one-digit",
    description: "Short division",
    members: (f) => f.a >= 13 && f.a <= 199 && f.b >= 2 && f.b <= 9,
  },
  {
    id: "div-long",
    label: "Long division",
    description: "Multi-digit ÷ two-digit",
    members: (f) => f.b >= 11,
  },
];

export const STRANDS_BY_OP = {
  addition: ADDITION_STRANDS,
  subtraction: SUBTRACTION_STRANDS,
  multiplication: MULTIPLICATION_STRANDS,
  division: DIVISION_STRANDS,
};

// First strand a fact belongs to (deterministic by ordering).
// Returns null if no strand claims it (shouldn't happen if curriculum
// covers the fact pool — every existing 0-12 fact is covered by the
// "remaining" catch-all).
export function strandIdFor(op, fact) {
  const strands = STRANDS_BY_OP[op];
  if (!strands) return null;
  for (const s of strands) {
    if (s.members(fact)) return s.id;
  }
  return null;
}

// Convenience: get the strand definition object by id.
const STRAND_BY_ID = {};
for (const op of Object.keys(STRANDS_BY_OP)) {
  for (const s of STRANDS_BY_OP[op]) {
    STRAND_BY_ID[s.id] = { ...s, op };
  }
}
export function strandById(strandId) {
  return STRAND_BY_ID[strandId] || null;
}

// ============================================================
// CURATED 2-DIGIT FACT POOLS
//
// The 2-digit strands above use predicates that COULD match millions
// of facts. We don't want to enumerate them all. Instead, each
// 2-digit strand has a curated sample (~20-30 facts) added at
// buildFacts time. These functions return those samples.
// ============================================================

// Addition: 2-digit + 1-digit, no carry
export function buildAdd2d1dNoCarry() {
  const facts = [];
  // Pick (a in {13, 22, 31, 44, 52, 63, 71, 82, 90}, b in {1..(9-ones)})
  const aValues = [13, 22, 31, 44, 52, 63, 71, 82, 90];
  for (const a of aValues) {
    const ones = a % 10;
    for (let b = 1; b <= 9 - ones && b <= 9; b++) {
      facts.push({ a, b, answer: a + b });
    }
  }
  return facts;
}

// Addition: 2-digit + 1-digit, with carry
export function buildAdd2d1dCarry() {
  const facts = [];
  const aValues = [16, 25, 37, 48, 56, 67, 75, 89, 94];
  for (const a of aValues) {
    const ones = a % 10;
    for (let b = 10 - ones; b <= 9; b++) {
      if (a + b <= 200) facts.push({ a, b, answer: a + b });
    }
  }
  return facts;
}

// Addition: 2-digit + 2-digit, no carry
export function buildAdd2d2dNoCarry() {
  const samples = [
    [12, 34], [21, 45], [33, 24], [42, 17], [53, 26],
    [11, 88], [25, 71], [36, 52], [44, 33], [62, 27],
    [71, 18], [15, 43], [23, 64], [34, 35], [41, 28],
    [52, 36], [63, 25], [74, 14], [82, 17], [27, 51],
  ];
  return samples.map(([a, b]) => ({ a, b, answer: a + b }));
}

// Addition: 2-digit + 2-digit, with carry
export function buildAdd2d2dCarry() {
  const samples = [
    [17, 25], [28, 46], [39, 18], [47, 35], [56, 27],
    [68, 24], [73, 19], [85, 36], [49, 27], [54, 38],
    [67, 25], [76, 18], [85, 27], [38, 47], [49, 36],
    [57, 26], [68, 35], [76, 48], [85, 29], [29, 73],
    [37, 65], [48, 56], [56, 47], [59, 38], [68, 26],
  ];
  return samples.map(([a, b]) => ({ a, b, answer: a + b }));
}

// Subtraction: 2-digit − 1-digit, no borrow
export function buildSub2d1dNoBorrow() {
  const facts = [];
  const aValues = [15, 24, 36, 47, 58, 65, 77, 86, 99];
  for (const a of aValues) {
    const ones = a % 10;
    for (let b = 1; b <= ones; b++) {
      facts.push({ a, b, answer: a - b });
    }
  }
  return facts;
}

// Subtraction: 2-digit − 1-digit, with borrow
export function buildSub2d1dBorrow() {
  const facts = [];
  const aValues = [12, 23, 34, 41, 52, 63, 71, 84, 91];
  for (const a of aValues) {
    const ones = a % 10;
    for (let b = ones + 1; b <= 9; b++) {
      facts.push({ a, b, answer: a - b });
    }
  }
  return facts;
}

// Subtraction: 2-digit − 2-digit, no borrow
export function buildSub2d2dNoBorrow() {
  const samples = [
    [45, 23], [56, 34], [67, 41], [78, 52], [89, 63],
    [34, 12], [55, 24], [66, 35], [77, 26], [88, 47],
    [99, 58], [42, 21], [53, 22], [64, 33], [75, 44],
    [86, 55], [97, 66], [48, 27], [59, 38], [69, 28],
  ];
  return samples.map(([a, b]) => ({ a, b, answer: a - b }));
}

// Subtraction: 2-digit − 2-digit, with borrow
export function buildSub2d2dBorrow() {
  const samples = [
    [43, 18], [52, 27], [61, 35], [73, 48], [82, 56],
    [91, 67], [54, 29], [63, 38], [72, 47], [85, 49],
    [94, 58], [44, 18], [53, 29], [62, 37], [71, 48],
    [83, 56], [92, 67], [44, 27], [55, 38], [66, 49],
    [37, 19], [48, 29], [56, 28], [67, 39], [73, 56],
  ];
  return samples.map(([a, b]) => ({ a, b, answer: a - b }));
}

// Multiplication: 2-digit × 1-digit
export function buildMul2d1d() {
  const samples = [
    [13, 3], [14, 5], [15, 4], [16, 6], [17, 3],
    [18, 5], [19, 4], [21, 6], [23, 4], [24, 7],
    [25, 8], [27, 3], [29, 4], [32, 5], [35, 6],
    [37, 4], [42, 3], [45, 6], [48, 5], [56, 7],
  ];
  return samples.map(([a, b]) => ({ a, b, answer: a * b }));
}

// Multiplication: 2-digit × 2-digit
export function buildMul2d2d() {
  const samples = [
    [11, 12], [12, 13], [13, 14], [14, 15], [15, 16],
    [17, 18], [19, 21], [22, 23], [24, 11], [25, 13],
    [16, 14], [18, 17], [21, 19], [23, 24], [25, 16],
  ];
  return samples.map(([a, b]) => ({ a, b, answer: a * b }));
}

// Division: multi-digit ÷ 1-digit
export function buildDiv2d1d() {
  // Inverse of mul-2d-1d facts above so they're guaranteed exact.
  const samples = [
    [39, 3], [70, 5], [60, 4], [96, 6], [51, 3],
    [90, 5], [76, 4], [126, 6], [92, 4], [168, 7],
    [200, 8], [81, 3], [116, 4], [160, 5], [210, 6],
    [148, 4], [126, 3], [270, 6], [240, 5], [392, 7],
  ];
  return samples.map(([a, b]) => ({ a, b, answer: a / b }));
}

// Division: long (multi-digit ÷ 2-digit)
export function buildDivLong() {
  const samples = [
    [132, 11], [144, 12], [169, 13], [196, 14], [225, 15],
    [255, 17], [378, 18], [399, 21], [506, 22], [552, 23],
    [264, 12], [255, 15], [336, 16], [294, 14], [400, 16],
  ];
  return samples.map(([a, b]) => ({ a, b, answer: a / b }));
}

// Catalog of curated builders by strand id — used by buildFacts.
export const TWO_DIGIT_BUILDERS = {
  "add-2d-1d-no-carry": { op: "addition", build: buildAdd2d1dNoCarry, makeId: (a, b) => `add-${a}+${b}` },
  "add-2d-1d-carry":    { op: "addition", build: buildAdd2d1dCarry,    makeId: (a, b) => `add-${a}+${b}` },
  "add-2d-2d-no-carry": { op: "addition", build: buildAdd2d2dNoCarry, makeId: (a, b) => `add-${a}+${b}` },
  "add-2d-2d-carry":    { op: "addition", build: buildAdd2d2dCarry,    makeId: (a, b) => `add-${a}+${b}` },
  "sub-2d-1d-no-borrow":{ op: "subtraction", build: buildSub2d1dNoBorrow, makeId: (a, b) => `sub-${a}-${b}` },
  "sub-2d-1d-borrow":   { op: "subtraction", build: buildSub2d1dBorrow,   makeId: (a, b) => `sub-${a}-${b}` },
  "sub-2d-2d-no-borrow":{ op: "subtraction", build: buildSub2d2dNoBorrow, makeId: (a, b) => `sub-${a}-${b}` },
  "sub-2d-2d-borrow":   { op: "subtraction", build: buildSub2d2dBorrow,   makeId: (a, b) => `sub-${a}-${b}` },
  "mul-2d-1d":          { op: "multiplication", build: buildMul2d1d, makeId: (a, b) => `mul-${a}x${b}` },
  "mul-2d-2d":          { op: "multiplication", build: buildMul2d2d, makeId: (a, b) => `mul-${a}x${b}` },
  "div-2d-1d":          { op: "division", build: buildDiv2d1d, makeId: (a, b) => `div-${a}d${b}` },
  "div-long":           { op: "division", build: buildDivLong, makeId: (a, b) => `div-${a}d${b}` },
};
