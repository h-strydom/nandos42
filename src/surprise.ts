import { type Menu, type MenuNode, type Preferences, type Selection, matchesAny, selectionPrice } from "./menu.js";

export type Heat = "lemon-herb" | "mild" | "hot" | "xtra-hot" | "any";

export interface SurpriseOptions {
  people?: number;
  budgetRands?: number;
  heat?: Heat;
  drinks?: boolean;
  dessert?: boolean;
  vegetarian?: boolean;
  avoid?: string[];
  /** Free-form option names to steer towards, e.g. "halloumi", "wedges". */
  wants?: string[];
  seed?: number;
  /** Hard ceiling: the budget never exceeds this. */
  spendCapRands?: number;
}

export interface PlannedItem {
  selection: Selection;
  quantity: number;
}

export interface Plan {
  items: PlannedItem[];
  totalCents: number;
}

const HEAT_FLAVOURS: Record<Exclude<Heat, "any">, string[]> = {
  "lemon-herb": ["Lemon & Herb"],
  mild: ["Mild", "Lemon & Herb"],
  hot: ["Hot"],
  "xtra-hot": ["Xtra Hot"],
};
const ALL_FLAVOURS = ["Lemon & Herb", "Mild", "Hot", "Xtra Hot", "BBQ", "Tangy Tomato", "Mozam Paprika"];

const MAIN_CATS = /classics|burgers|pitas|wraps|bowls|salads|pulled chicken/i;
const SHARE_CATS = /to share|platters/i;
const DESSERT_CATS = /treats/i;
const DRINK_CATS = /drinks/i;
const VEG = /\bveg|halloumi|bean|falafel|plant|mushroom/i;
const MEAT = /chicken|winglet|\bwings?\b|liver|sosatie|prego|beef|trinchado|fillet|strips|thigh|breast|\bleg\b|pulled/i;
const KIDS = /nandinos|kids/i;
const DRINK_NAME = /coke|sprite|fanta|stoney|creme soda|valpr|cappy|rubro|tiser|bloom|sunset|soda|juice|iced tea|water|\b1\.5l\b/i;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const leafNames = (s: Selection): string[] => [s.node.name, ...s.children.flatMap(leafNames)];

export function planSurprise(menu: Menu, opts: SurpriseOptions = {}): Plan {
  const people = Math.max(1, Math.min(opts.people ?? 1, 12));
  const rng = mulberry32(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
  const pickOne = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];
  const avoid = opts.avoid ?? [];
  const cap = opts.spendCapRands ?? Infinity;
  const budgetRands = Math.min(opts.budgetRands ?? people * 200, cap);
  const budget = Math.round(budgetRands * 100);
  const drinks = opts.drinks ?? true;

  const ok = (p: MenuNode) => !matchesAny(p.name, avoid) && !KIDS.test(p.name);
  const vegOk = (p: MenuNode) => !opts.vegetarian || (VEG.test(p.name) && !MEAT.test(p.name));
  const inCat = (re: RegExp) => menu.orderable.filter((p) => re.test(menu.category(p)) && ok(p));

  // Vegetarian applies to food that might contain meat; drinks and desserts are fine as-is.
  const mains = inCat(MAIN_CATS).filter(vegOk);
  const meals = mains.filter((p) => p.name.includes("+"));
  const mainPool = meals.length >= 3 ? meals : mains;
  const sharePool = inCat(SHARE_CATS).filter(vegOk);
  const desserts = inCat(DESSERT_CATS);
  const drinkPool = inCat(DRINK_CATS).filter((p) => /buddy|can|bottomless|valpr|cappy|rubro/i.test(p.name) && !/1\.5l/i.test(p.name));
  if (!mainPool.length) throw new Error("Couldn't find any mains on this store's menu that match your constraints.");

  const flavourWants = () => {
    if (opts.heat && opts.heat !== "any") return HEAT_FLAVOURS[opts.heat];
    return [pickOne(ALL_FLAVOURS)];
  };

  const build = (product: MenuNode, extra: Partial<Preferences> = {}): Selection | null => {
    try {
      const { selection } = menu.configure(product, {
        prefer: flavourWants(),
        wants: opts.wants ?? [],
        avoid,
        addDrink: extra.addDrink ?? false,
        randomness: 0.9,
        rng,
      });
      // Belt and braces: no meat anywhere in a vegetarian selection (e.g. a meaty side or add-on).
      if (opts.vegetarian && leafNames(selection).slice(1).some((n) => MEAT.test(n) && !VEG.test(n))) return null;
      return selection;
    } catch {
      return null;
    }
  };

  const attempt = (): Plan | null => {
    const items: PlannedItem[] = [];
    let remaining = people;

    // Groups of 3+: sometimes go for a sharing chicken / platter covering ~3-4 people.
    if (people >= 3 && sharePool.length && rng() < 0.6) {
      const s = build(pickOne(sharePool), { addDrink: drinks });
      if (s) {
        items.push({ selection: s, quantity: 1 });
        remaining -= Math.min(4, people);
      }
    }
    for (let i = 0; i < remaining; i++) {
      const sel = build(pickOne(mainPool), { addDrink: drinks });
      if (!sel) return null;
      items.push({ selection: sel, quantity: 1 });
    }

    // Drinks for anyone whose meal didn't come with one (a 1.5L counts for the table).
    if (drinks && drinkPool.length) {
      const bottles = items.filter((it) => leafNames(it.selection).some((n) => /\b1\.5l\b/i.test(n))).length;
      const withDrink = bottles ? people : items.filter((it) => hasDrink(it.selection)).length;
      for (let i = withDrink; i < people; i++) {
        const d = build(pickOne(drinkPool));
        if (d) items.push({ selection: d, quantity: 1 });
      }
    }

    if (opts.dessert && desserts.length) {
      for (let i = 0; i < Math.ceil(people / 2); i++) {
        const d = build(pickOne(desserts));
        if (d) items.push({ selection: d, quantity: 1 });
      }
    }

    return { items: merge(items), totalCents: items.reduce((s, it) => s + selectionPrice(it.selection) * it.quantity, 0) };
  };

  let cheapest: Plan | null = null;
  for (let tries = 0; tries < 80; tries++) {
    const plan = attempt();
    if (!plan) continue;
    if (plan.totalCents <= budget) return plan;
    if (!cheapest || plan.totalCents < cheapest.totalCents) cheapest = plan;
  }
  if (cheapest) {
    const capNote = budgetRands === cap ? " (limited by your spend cap)" : "";
    throw new Error(
      `Couldn't fit a surprise for ${people} into R${budgetRands.toFixed(0)}${capNote}; the cheapest I found was R${(cheapest.totalCents / 100).toFixed(2)}. Raise the budget or drop drinks/dessert.`,
    );
  }
  throw new Error("Couldn't build a valid order from this store's menu. Try different constraints.");
}

function hasDrink(sel: Selection): boolean {
  return sel.children.length > 0 && leafNames(sel).slice(1).some((n) => DRINK_NAME.test(n));
}

/** Collapse identical configurations into one line with a quantity. */
function merge(items: PlannedItem[]): PlannedItem[] {
  const key = (s: Selection): string => s.node.id + "(" + s.children.map(key).sort().join(",") + ")";
  const map = new Map<string, PlannedItem>();
  for (const it of items) {
    const k = key(it.selection);
    const prev = map.get(k);
    if (prev) prev.quantity += it.quantity;
    else map.set(k, { ...it });
  }
  return [...map.values()];
}
