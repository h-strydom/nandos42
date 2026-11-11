/**
 * Menu model + configurator.
 *
 * A menu product is a tree. Rules (reverse-engineered from the website):
 *  - Nodes without a productType (or COMBO_SIDE / multi-option COMBO_MAIN) are
 *    option groups; their children are the choices.
 *  - A group's `quantity` is how many children may be picked; quantity 1 is a radio group.
 *  - `mandatory` nodes must be selected. A mandatory leaf is always selected; a mandatory
 *    group needs a choice made inside it.
 *  - The basket payload is the tree of selected nodes: {productId, children: [...]}.
 *  - Price = sum of `price` over every selected node.
 */
import type { BasketChildPayload, BasketItemPayload } from "./api.js";

export interface RawProduct {
  id: string;
  srcId?: string;
  productDefinitionId: string;
  productType?: string;
  price?: number;
  quantity?: number;
  default?: boolean;
  mandatory?: boolean;
  relatedProducts?: RawProduct[];
}

interface RawDefinition {
  id: string;
  name?: string;
  shortName?: string;
  description?: string;
}

interface RawCategory {
  id: string;
  name: string;
  children: Array<{ destinationType: string; destinationId: string }>;
}

export interface RawMenu {
  id: string;
  products: RawProduct[];
  productDefinitions: RawDefinition[];
  categories: RawCategory[];
  rootCategories: Array<{ destinationType: string; destinationId: string }>;
}

export class MenuNode {
  readonly children: MenuNode[];
  readonly name: string;
  description?: string;

  constructor(
    readonly raw: RawProduct,
    readonly parent: MenuNode | null,
    menu: Menu,
  ) {
    const def = menu.definitions.get(raw.productDefinitionId);
    this.name = (def?.name ?? raw.srcId ?? "?").trim().replace(/\s+/g, " ");
    this.description = def?.description?.trim() || undefined;
    this.children = (raw.relatedProducts ?? []).map((r) => new MenuNode(r, this, menu));
    this.available = !menu.excluded.has(raw.productDefinitionId) && (this.isLeaf || this.children.some((c) => c.available));
  }

  readonly available: boolean;

  get id() {
    return this.raw.id;
  }
  get price() {
    return this.raw.price ?? 0;
  }
  get isLeaf() {
    return this.children.length === 0;
  }
  get mandatory() {
    return !!this.raw.mandatory;
  }
  /** Children that are choices rather than fixed components. */
  get isGroup(): boolean {
    const t = this.raw.productType;
    if (!t) return this.children.length > 0;
    if (t === "COMBO_SIDE") return true;
    if (t === "COMBO_MAIN" && this.children.length > 1) return true;
    if (t === "CONDIMENT" && this.children.length > 0) return true;
    return false;
  }
  /** A group whose children are themselves groups ("How d'ya like it?" → flavours, extras...). */
  get isContainer(): boolean {
    return this.isGroup && this.children.length > 0 && this.children.every((c) => c.isGroup);
  }
  get maxPicks(): number {
    return this.raw.quantity && this.raw.quantity > 0 ? this.raw.quantity : 1;
  }
  get availableChildren() {
    return this.children.filter((c) => c.available);
  }
  /** Mandatory and nothing to decide: e.g. the chicken inside a chicken combo. */
  get alwaysSelected(): boolean {
    if (!this.mandatory) return false;
    let n: MenuNode = this;
    while (n.children.length === 1) n = n.children[0];
    return n.isLeaf;
  }
}

export interface Selection {
  node: MenuNode;
  children: Selection[];
}

export interface Preferences {
  /** Option names to choose, e.g. ["hot", "peri-peri chips", "coke"]. Each is used at most once. */
  wants?: string[];
  /** Option names that only steer choices; never switch on optional extras. */
  prefer?: string[];
  /** Words that disqualify an option, e.g. ["coleslaw", "bbq"]. */
  avoid?: string[];
  /** Add a drink where the product offers one. */
  addDrink?: boolean;
  /** 0..1, how adventurous random picks are. 0 = cheapest / first option. */
  randomness?: number;
  rng?: () => number;
}

export interface Configured {
  selection: Selection;
  /** Entries of `wants` that matched nothing. */
  unmatched: string[];
}

export class ConfigError extends Error {}

/** Normalise names for matching, folding common spellings ("Extra Hot" -> "xtra hot"). */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bextra\b/g, "xtra")
    .replace(/\bx ?hot\b/g, "xtra hot")
    .replace(/\s+/g, " ")
    .trim();

// norm() leaves only [a-z0-9 ], so no regex escaping is needed.
const wordRe = (q: string) => new RegExp(`(^| )${q}( |$)`);

/** How well an option name matches one wanted phrase (0 = no match). */
export function matchScore(name: string, want: string): number {
  const n = norm(name);
  const q = norm(want);
  if (!q || !n) return 0;
  // "onion" must not select "No Onion"; only "no onion" may.
  if (/^no /.test(n) && !/^no /.test(q)) return 0;
  if (n === q) return 1000;
  // Fewer extra words wins ties: "coke" prefers "Coke (Buddy)" over "Coke Light (Buddy)".
  const extra = n.split(" ").length - q.split(" ").length;
  if (wordRe(q).test(n)) return 100 + q.length * 2 - extra;
  if (n.includes(q)) return 10 + q.length - extra * 0.1;
  return 0;
}

function bestScore(name: string, wants: string[]): number {
  return wants.reduce((m, w) => Math.max(m, matchScore(name, w)), 0);
}

/** Best match against the still-unused wants; earlier wants win ties (the user's order counts). */
function bestUnused(name: string, ctx: Ctx): number {
  let best = 0;
  ctx.wants.forEach((w, i) => {
    if (ctx.used[i] > 0) return;
    const sc = matchScore(name, w);
    if (sc > 0) best = Math.max(best, sc - i * 0.5);
  });
  return best;
}

/** Whole-word match against any of the words (used for avoid lists). */
export function matchesAny(name: string, words: string[]): boolean {
  const n = norm(name);
  return words.some((w) => {
    const q = norm(w);
    return !!q && wordRe(q).test(n);
  });
}

const DRINK_GROUP = /drink|beverage/i;

type Ctx = {
  wants: string[];
  /** How many times each entry of `wants` has been used. */
  used: number[];
  prefer: string[];
  avoid: string[];
  addDrink: boolean;
  randomness: number;
  rng: () => number;
  failure?: string;
};

const unusedWants = (ctx: Ctx) => ctx.wants.filter((_, i) => ctx.used[i] === 0);
const usedWants = (ctx: Ctx) => ctx.wants.filter((_, i) => ctx.used[i] > 0);

function markUsed(ctx: Ctx, name: string) {
  let best = -1;
  let bestS = 0;
  ctx.wants.forEach((w, i) => {
    // Prefer consuming a want that hasn't been used yet.
    const s = matchScore(name, w) * (ctx.used[i] === 0 ? 10 : 1);
    if (s > bestS) {
      bestS = s;
      best = i;
    }
  });
  if (best >= 0) ctx.used[best]++;
}

export class Menu {
  readonly definitions = new Map<string, RawDefinition>();
  readonly products: MenuNode[];
  readonly categoryOf = new Map<string, string>();

  constructor(
    raw: RawMenu,
    readonly excluded: Set<string> = new Set(),
  ) {
    for (const d of raw.productDefinitions) this.definitions.set(d.id, d);
    this.products = raw.products.map((p) => new MenuNode(p, null, this));
    this.indexCategories(raw);
  }

  private indexCategories(raw: RawMenu) {
    const cats = new Map(raw.categories.map((c) => [c.id, c]));
    const visit = (id: string, path: string[], depth: number) => {
      const c = cats.get(id);
      if (!c || depth > 5) return;
      const here = [...path, c.name.trim()];
      for (const ch of c.children) {
        if (ch.destinationType === "PRODUCT_DEFINITION") {
          if (!this.categoryOf.has(ch.destinationId)) this.categoryOf.set(ch.destinationId, here.join(" > "));
        } else if (ch.destinationType === "CATEGORY_DEFINITION") {
          visit(ch.destinationId, here, depth + 1);
        }
      }
    };
    // "Most Popular" duplicates other categories; index it last so real categories win.
    const roots = raw.rootCategories.map((r) => r.destinationId);
    const popular = roots.filter((id) => /popular/i.test(cats.get(id)?.name ?? ""));
    for (const id of [...roots.filter((r) => !popular.includes(r)), ...popular]) visit(id, [], 0);
  }

  category(p: MenuNode): string {
    return this.categoryOf.get(p.raw.productDefinitionId) ?? "Other";
  }

  /** Orderable top-level products (available and listed in a category). */
  get orderable(): MenuNode[] {
    return this.products.filter((p) => p.available && this.categoryOf.has(p.raw.productDefinitionId));
  }

  find(query: string): MenuNode[] {
    const scored = this.orderable
      .map((p) => ({ p, s: matchScore(p.name, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.map((x) => x.p);
  }

  resolve(productIdOrName: string): MenuNode {
    const byId = this.products.find((p) => p.id === productIdOrName || p.raw.productDefinitionId === productIdOrName);
    if (byId) {
      if (!byId.available) throw new ConfigError(`"${byId.name}" is not available at this store right now.`);
      if (!this.orderable.includes(byId)) throw new ConfigError(`"${byId.name}" isn't on this store's public menu.`);
      return byId;
    }
    const hits = this.find(productIdOrName);
    if (hits.length === 0) throw new ConfigError(`No menu item matches "${productIdOrName}". Use nandos_menu to search.`);
    const exact = hits.filter((h) => norm(h.name) === norm(productIdOrName));
    if (exact.length >= 1) return exact[0];
    // Close scores mean the name doesn't really pick one product ("chicken", "burger").
    if (hits.length > 1 && matchScore(hits[0].name, productIdOrName) - matchScore(hits[1].name, productIdOrName) < 5) {
      throw new ConfigError(
        `"${productIdOrName}" is ambiguous: ${hits
          .slice(0, 8)
          .map((h) => `"${h.name}"`)
          .join(", ")}. Use the exact name or the product id.`,
      );
    }
    return hits[0];
  }

  // ---- configuration ---------------------------------------------------

  /**
   * Turn preferences into a valid selection. With `strict`, any want that matches
   * nothing throws (so "Xtra Hott" doesn't silently become the default flavour).
   */
  configure(product: MenuNode, prefs: Preferences = {}, strict = false): Configured {
    const wants = prefs.wants ?? [];
    const ctx: Ctx = {
      wants,
      used: wants.map(() => 0),
      prefer: prefs.prefer ?? [],
      avoid: prefs.avoid ?? [],
      addDrink: prefs.addDrink ?? false,
      randomness: prefs.randomness ?? 0,
      rng: prefs.rng ?? Math.random,
    };
    if (!product.available) throw new ConfigError(`"${product.name}" is not available at this store right now.`);
    const selection = this.configureNode(product, ctx);
    if (!selection) {
      throw new ConfigError(`Could not configure "${product.name}": ${ctx.failure ?? "no valid combination of options"}.`);
    }
    const unmatched = wants.filter((_, i) => ctx.used[i] === 0);
    if (strict && unmatched.length) {
      throw new ConfigError(
        `"${product.name}" has no option matching ${unmatched.map((u) => `"${u}"`).join(", ")}. Nothing was added. Use nandos_item_options to see the exact option names.`,
      );
    }
    return { selection, unmatched };
  }

  private configureNode(node: MenuNode, ctx: Ctx): Selection | null {
    if (node.isLeaf) return { node, children: [] };
    return node.isGroup && !node.isContainer ? this.configureGroup(node, ctx) : this.configureComponents(node, ctx);
  }

  /** Product (or container): each child is an independent component. */
  private configureComponents(node: MenuNode, ctx: Ctx): Selection | null {
    const chosen = new Map<MenuNode, Selection>();
    // Mandatory parts first, so e.g. "hot" is used up by the flavour choice
    // and doesn't also switch on the optional "Add More Flavour" extra.
    // Fixed components (the chicken, the burger) before choice groups (sides), so a want
    // like "hot" lands on the main item's flavour rather than pulling in a side that
    // happens to have a sauce choice. The output keeps menu order.
    const mandatory = node.children.filter((c) => c.mandatory);
    const ordered = [...mandatory.filter((c) => !c.isGroup), ...mandatory.filter((c) => c.isGroup)];
    for (const child of ordered) {
      if (!child.available) {
        ctx.failure ??= `required part "${child.name}" is unavailable at this store`;
        return null;
      }
      const s = this.configureNode(child, ctx) ?? (child.alwaysSelected ? { node: child, children: [] } : null);
      if (!s) return null;
      chosen.set(child, s);
    }
    for (const child of node.children) {
      if (child.mandatory || !child.available) continue;
      const wanted =
        this.subtreeWantScore(child, unusedWants(ctx)) > 0 || (ctx.addDrink && child.isGroup && DRINK_GROUP.test(child.name));
      if (wanted) {
        const s = this.configureNode(child, ctx);
        if (s) chosen.set(child, s);
      }
    }
    const children = node.children.filter((c) => chosen.has(c)).map((c) => chosen.get(c)!);
    if (node.isContainer && children.length === 0) return null;
    return { node, children };
  }

  /** Option group: pick between 1 and maxPicks of the children. */
  private configureGroup(node: MenuNode, ctx: Ctx): Selection | null {
    const available = node.availableChildren;
    const options = available.filter((c) => !matchesAny(c.name, ctx.avoid));
    if (options.length === 0) {
      ctx.failure ??= available.length
        ? `every option for "${node.name}" is excluded by your avoid list`
        : `nothing for "${node.name}" is available at this store`;
      return null;
    }
    const fixed = options.filter((c) => c.mandatory);
    const choices = options.filter((c) => !c.mandatory);

    const max = node.maxPicks;
    const children: Selection[] = [];
    for (const f of fixed) {
      const s = this.configureNode(f, ctx);
      if (s) children.push(s);
    }

    // First pick: the best option overall (a wanted one, else a sensible default).
    const unused = unusedWants(ctx);
    const used = usedWants(ctx);
    const ownUnused = choices.map((c) => bestUnused(c.name, ctx));
    const anyDirect = ownUnused.some((x) => x > 0);
    const scored = choices.map((c, i) => {
      // 1. Direct match on a want not used yet; earlier wants win ties.
      // 2. Only if nothing matches directly: a match deeper inside the option
      //    (e.g. a side that has the wanted sauce inside it).
      // 3. Faint preference, in single-choice sauce groups only, for a flavour already
      //    used (the same heat on a side's sauce). Never on paid options.
      const deep = anyDirect ? 0 : c.children.reduce((m, ch) => Math.max(m, this.subtreeWantScore(ch, unused)), 0) * 0.5;
      const reuse = max === 1 && c.raw.productType === "CONDIMENT" && c.price === 0 ? bestScore(c.name, used) * 0.05 : 0;
      const want = Math.max(ownUnused[i], deep, reuse);
      const pref = ctx.prefer.some((p) => matchScore(c.name, p) >= 1000) ? 50 : 0;
      const calm = 1 - ctx.randomness;
      const jitter = ctx.rng() * ctx.randomness * 50 - i * calm * 0.01;
      const isDefault = c.raw.default ? 5 * calm : 0;
      // Without a stated want, prefer free options over paid upgrades,
      // and plain flavours over "No Sauce" / half-and-half.
      const cost = (c.price / 100) * 0.2 * (calm + 0.1);
      const odd = /(^|\/\s*)no sauce|^no /i.test(c.name) ? 20 : / \/ |half (and|&) half/i.test(c.name) ? 10 : 0;
      return { c, s: want + pref + jitter + isDefault - cost - odd };
    });
    scored.sort((x, y) => y.s - x.s);

    const picked = new Set<MenuNode>();
    const take = (c: MenuNode) => {
      const sel = this.configureNode(c, ctx);
      if (!sel) return false;
      children.push(sel);
      picked.add(c);
      markUsed(ctx, c.name);
      return true;
    };
    for (const x of scored) if (take(x.c)) break;

    // Further picks (multi-choice groups like extras): only for wants still unused,
    // one want per pick, so "cheese" adds Add Cheese, not Double Cheese as well.
    while (picked.size < max) {
      let best: MenuNode | null = null;
      let bestS = 0;
      for (const c of choices) {
        if (picked.has(c)) continue;
        const sc = bestUnused(c.name, ctx);
        if (sc >= 10 && sc > bestS) {
          bestS = sc;
          best = c;
        }
      }
      if (!best || !take(best)) break;
    }
    return children.length ? { node, children } : null;
  }
  private subtreeWantScore(node: MenuNode, wants: string[]): number {
    if (!wants.length || !node.available) return 0;
    let best = node.isGroup ? 0 : bestScore(node.name, wants);
    for (const c of node.children) best = Math.max(best, this.subtreeWantScore(c, wants));
    return best;
  }
}

// ---- selection helpers ----------------------------------------------------

export function selectionPrice(sel: Selection): number {
  return sel.node.price + sel.children.reduce((sum, c) => sum + selectionPrice(c), 0);
}

/** Human-readable summary of the choices made (skips fixed components). */
export function describeSelection(sel: Selection): string {
  const counts = new Map<string, number>();
  const walk = (s: Selection) => {
    // A choice made in a group (leaf or not, e.g. a side that has its own sauce choice).
    const chosenOption = s.node.parent?.isGroup && !s.node.isGroup && !s.node.alwaysSelected;
    if (chosenOption || (s.node.isLeaf && s.node.parent && !s.node.alwaysSelected)) {
      const name = s.node.name.replace(/^CM - /, "");
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    s.children.forEach(walk);
  };
  walk(sel);
  return [...counts].map(([name, n]) => (n > 1 ? `${n}x ${name}` : name)).join(", ");
}

export function toBasketPayload(sel: Selection, quantity = 1): BasketItemPayload {
  const child = (s: Selection): BasketChildPayload =>
    s.node.isLeaf ? { productId: s.node.id } : { productId: s.node.id, children: s.children.map(child) };
  const payload: BasketItemPayload = { productId: sel.node.id, quantity, computedDescription: describeSelection(sel) };
  if (!sel.node.isLeaf) payload.children = sel.children.map(child);
  return payload;
}

/** Compact option tree for agents to read. */
export function describeOptions(product: MenuNode, depth = 0, maxDepth = 5): string {
  const lines: string[] = [];
  const pad = (d: number) => "  ".repeat(d);
  const walk = (n: MenuNode, d: number) => {
    if (d > maxDepth) return;
    for (const c of n.children) {
      if (!c.available) continue;
      const price = c.price ? ` (+R${(c.price / 100).toFixed(2)})` : "";
      if (c.isGroup && !c.isLeaf) {
        const rule = c.isContainer ? "optional extras" : c.mandatory ? `choose ${c.maxPicks === 1 ? "1" : `1-${c.maxPicks}`}` : `optional, up to ${c.maxPicks}`;
        lines.push(`${pad(d)}- ${c.name.replace(/^CM - /, "")} [${rule}]${price}`);
        walk(c, d + 1);
      } else if (c.alwaysSelected) {
        if (!c.isLeaf) {
          walk(c, d); // flatten fixed wrappers
        } else if (d > 0 || product.children.length > 1) {
          lines.push(`${pad(d)}- ${c.name.replace(/^CM - /, "")} (included)${price}`);
        }
      } else {
        lines.push(`${pad(d)}- ${c.name}${price}`);
        if (!c.isLeaf) walk(c, d + 1);
      }
    }
  };
  walk(product, depth);
  return lines.join("\n");
}

export const rands = (cents: number) => `R${(cents / 100).toFixed(2)}`;
