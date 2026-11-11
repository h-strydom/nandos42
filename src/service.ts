import { createHash } from "node:crypto";
import { type Basket, NandosApi, NandosError, type PaymentRequirements, type Store } from "./api.js";
import { loadConfig, updateConfig, validSpendCap } from "./config.js";
import { Menu, type MenuNode, type Preferences, describeSelection, rands, selectionPrice, toBasketPayload } from "./menu.js";
import { type Plan, type SurpriseOptions, planSurprise } from "./surprise.js";

const MENU_TTL_MS = 10 * 60 * 1000;
const STORES_TTL_MS = 60 * 60 * 1000;

type Intent = NonNullable<PaymentRequirements["unpaidOrderPaymentIntents"]>[number];

export class NandosService {
  readonly api = new NandosApi();
  private menuCache?: { key: string; at: number; menu: Menu };
  private storesCache?: { at: number; stores: Store[] };
  /** Serialises basket changes and checkout so a parallel add can't slip in mid-checkout. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Baskets this process has sent to the order endpoint (double-order guard): id -> when + what. */
  private submitted = new Map<string, { at: number; code: string }>();

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---- stores ---------------------------------------------------------

  async findStores(opts: { lat?: number; lng?: number; query?: string; radiusKm?: number }): Promise<Store[]> {
    if (opts.query) {
      if (!this.storesCache || Date.now() - this.storesCache.at > STORES_TTL_MS) {
        this.storesCache = { at: Date.now(), stores: await this.api.allStores() };
      }
      const q = opts.query.toLowerCase();
      const rank = (s: Store) => (`${s.name} ${s.displayName ?? ""}`.toLowerCase().includes(q) ? 0 : 1);
      return this.storesCache.stores
        .filter((s) => `${s.name} ${s.displayName ?? ""} ${s.address ?? ""} ${s.code ?? ""}`.toLowerCase().includes(q))
        .filter((s) => s.collectionCapable !== false)
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, 15);
    }
    if ((opts.lat === undefined) !== (opts.lng === undefined)) throw new NandosError("Pass both lat and lng, or neither.");
    const home = loadConfig().home;
    const lat = opts.lat ?? home?.lat;
    const lng = opts.lng ?? home?.lng;
    if (lat === undefined || lng === undefined) {
      throw new NandosError("No location given. Pass lat/lng or a text query, or save a home location with nandos_set_home.");
    }
    const stores = await this.api.locateStores(lat, lng, opts.radiusKm ?? 10);
    return stores.filter((s) => s.collectionCapable !== false);
  }

  setStore(storeId: string): Promise<{ basket: Basket; notices: string[] }> {
    return this.lock(async () => {
      const before = await this.api.basket();
      let basket = await this.api.configureCollection(storeId);
      updateConfig({ storeId, storeName: basket.storeName?.trim() ?? undefined });
      this.menuCache = undefined;
      const notices: string[] = [];
      if (before.storeId !== storeId) basket = await this.reconcileLines(basket, notices);
      return { basket, notices };
    });
  }

  /**
   * After a store change, basket lines built from the previous store's menu carry product
   * ids this store doesn't know. Remove them (with a notice) so they can't be ordered here.
   * Call inside lock().
   */
  private async reconcileLines(basket: Basket, notices: string[]): Promise<Basket> {
    const lines = basket.basketItems ?? [];
    if (!lines.length) return basket;
    const menu = await this.loadMenu(basket);
    const stale = lines.filter((i) => !menu.products.some((p) => p.id === i.productId && p.available));
    if (!stale.length) return basket;
    for (const i of stale) basket = await this.api.removeItem(i.id);
    notices.push(
      `Removed ${stale.length} item(s) that aren't available at ${basket.storeName?.trim()}: ${stale.map((i) => i.productName.trim()).join(", ")}. Add them again from this store's menu if you still want them.`,
    );
    return basket;
  }

  /**
   * For operations that change the basket: make sure it is set to collection at the
   * user's chosen store. Any change made here is reported back as a notice.
   * Must be called inside lock().
   */
  private async prepareBasket(): Promise<{ basket: Basket; notices: string[] }> {
    const notices: string[] = [];
    let basket = await this.api.basket();
    const cfg = loadConfig();
    if (cfg.storeId) {
      if (basket.orderType !== "COLLECTION" || basket.storeId !== cfg.storeId) {
        const was = basket.storeId ? `${basket.orderType ?? "?"} at ${basket.storeName?.trim() ?? basket.storeId}` : "not set up";
        const storeChanged = basket.storeId !== cfg.storeId;
        basket = await this.api.configureCollection(cfg.storeId);
        this.menuCache = undefined;
        notices.push(`Your basket was ${was}; switched it to collection at ${basket.storeName?.trim()}.`);
        if (storeChanged) basket = await this.reconcileLines(basket, notices);
      }
    } else if (basket.orderType === "COLLECTION" && basket.storeId) {
      updateConfig({ storeId: basket.storeId, storeName: basket.storeName?.trim() ?? undefined });
      notices.push(`Using ${basket.storeName?.trim()}, the store already set on your basket.`);
    } else if (cfg.home) {
      const stores = await this.findStores({});
      const pick = stores.find((s) => s.capacity?.storeStatus === "AVAILABLE") ?? stores[0];
      if (!pick) throw new NandosError("No collection stores near your saved home location.");
      const storeChanged = basket.storeId !== pick.id;
      basket = await this.api.configureCollection(pick.id);
      this.menuCache = undefined;
      updateConfig({ storeId: pick.id, storeName: basket.storeName?.trim() ?? undefined });
      if (storeChanged) basket = await this.reconcileLines(basket, notices);
      notices.push(`No store was chosen, so I picked the nearest open one: ${basket.storeName?.trim()}.`);
    } else {
      throw new NandosError("No store selected. Use nandos_find_stores and nandos_set_store first (or nandos_set_home).");
    }
    return { basket, notices };
  }

  /** Read-only basket view; never changes anything. */
  async viewBasket(): Promise<{ basket: Basket; warnings: string[] }> {
    const basket = await this.api.basket();
    const cfg = loadConfig();
    const warnings: string[] = [];
    if (basket.orderType !== "COLLECTION") warnings.push(`Basket is set to ${basket.orderType ?? "nothing"}, not collection.`);
    if (cfg.storeId && basket.storeId !== cfg.storeId) {
      warnings.push(`Basket store (${basket.storeName?.trim() ?? "none"}) differs from your chosen store (${cfg.storeName ?? cfg.storeId}).`);
    }
    return { basket, warnings };
  }

  // ---- menu -----------------------------------------------------------

  private async loadMenu(basket: Basket): Promise<Menu> {
    const key = `${basket.storeId}:${basket.id}:${basket.menuId}`;
    if (this.menuCache && this.menuCache.key === key && Date.now() - this.menuCache.at < MENU_TTL_MS) return this.menuCache.menu;
    const [raw, excluded] = await Promise.all([this.api.menu(basket.menuId), this.api.exclusions(basket.id)]);
    const menu = new Menu(raw, excluded);
    this.menuCache = { key, at: Date.now(), menu };
    return menu;
  }

  menu(): Promise<{ menu: Menu; basket: Basket; notices: string[] }> {
    return this.lock(async () => {
      const { basket, notices } = await this.prepareBasket();
      return { menu: await this.loadMenu(basket), basket, notices };
    });
  }

  // ---- basket ---------------------------------------------------------

  addItem(product: string, prefs: Preferences, quantity = 1) {
    return this.lock(async () => {
      const { basket: before, notices } = await this.prepareBasket();
      const menu = await this.loadMenu(before);
      const node = menu.resolve(product);
      const { selection } = menu.configure(node, prefs, true);
      let basket: Basket;
      try {
        basket = await this.api.addItem(toBasketPayload(selection, quantity));
      } catch (e) {
        // The POST may have landed even though we got an error (timeout, failed re-read).
        // Retrying blindly would add a duplicate line, so check first.
        const now = await this.api.basket().catch(() => null);
        const beforeIds = new Set((before.basketItems ?? []).map((i) => i.id));
        const added = now?.basketItems?.some((i) => !beforeIds.has(i.id) && i.productId === node.id);
        if (!now || !added) {
          throw new NandosError(
            `${(e as Error).message}${now ? " The item was NOT added." : " It's unclear whether the item was added; check nandos_view_basket before retrying."}`,
          );
        }
        notices.push("Nando's returned an error, but the item was added. Don't add it again.");
        basket = now;
      }
      return { node, description: describeSelection(selection), basket, notices };
    });
  }

  removeItem(basketItemId: string): Promise<Basket> {
    return this.lock(() => this.api.removeItem(basketItemId));
  }

  clearBasket(): Promise<Basket> {
    return this.lock(() => this.removeItems());
  }

  /** Remove the given basket lines (default: all). Call inside lock(). */
  private async removeItems(ids?: string[]): Promise<Basket> {
    let basket = await this.api.basket();
    const targets = ids ?? (basket.basketItems ?? []).map((i) => i.id);
    for (const id of targets) basket = await this.api.removeItem(id);
    return basket;
  }

  /**
   * Plan a surprise and put it in the basket. New items are added before old ones are
   * removed, and a failure part-way removes what was added, so the basket is never left
   * half-built.
   */
  surprise(opts: SurpriseOptions & { replaceBasket?: boolean }): Promise<{ plan: Plan; basket: Basket; notices: string[] }> {
    return this.lock(async () => {
      const { basket: start, notices } = await this.prepareBasket();
      const menu = await this.loadMenu(start);
      const plan = planSurprise(menu, { ...opts, spendCapRands: validSpendCap(loadConfig()) ?? undefined });
      const replace = opts.replaceBasket ?? true;

      const oldIds = new Set((start.basketItems ?? []).map((i) => i.id));
      let basket = start;
      try {
        for (const it of plan.items) basket = await this.api.addItem(toBasketPayload(it.selection, it.quantity));
      } catch (e) {
        // Roll back against a fresh read, so lines whose POST landed despite an error go too.
        let rolledBack = false;
        try {
          const now = await this.api.basket();
          for (const i of now.basketItems ?? []) if (!oldIds.has(i.id)) await this.api.removeItem(i.id);
          rolledBack = true;
        } catch {
          /* reported below */
        }
        throw new NandosError(
          `Adding the surprise failed (${(e as Error).message}). ${rolledBack ? "Your basket is as it was before." : "Some surprise items may still be in the basket; check nandos_view_basket."}`,
        );
      }
      if (replace && oldIds.size) {
        try {
          basket = await this.removeItems([...oldIds]);
        } catch (e) {
          notices.push(
            `The surprise was added, but removing your previous items failed (${(e as Error).message}). The basket now has both; check nandos_view_basket and remove what you don't want.`,
          );
          basket = await this.api.basket().catch(() => basket);
        }
      }
      const surpriseTotal = (basket.basketItems ?? []).filter((i) => !oldIds.has(i.id)).reduce((t, i) => t + i.productPrice * i.quantity, 0);
      if (surpriseTotal !== plan.totalCents) {
        notices.push(`Nando's priced the surprise at ${rands(surpriseTotal)} (my estimate was ${rands(plan.totalCents)}).`);
      }
      return { plan, basket, notices };
    });
  }

  // ---- checkout -------------------------------------------------------

  checkout(opts: CheckoutOptions) {
    return this.lock(() => this.checkoutLocked(opts));
  }

  private async checkoutLocked(opts: CheckoutOptions) {
    const cfg = loadConfig();
    if (!cfg.credentials) {
      throw new NandosError(
        "Not logged in. Placing an order needs your Nando's account: run `nandos42 login` in a terminal (it walks you through it).",
      );
    }
    const me = await this.api.me();
    if (me.anonymous) throw new NandosError("Your saved login is for a logged-out session. Run `nandos42 login` again.");

    // Read-only: checkout never changes the basket or picks a store on its own.
    const basket = await this.api.basket();
    const items = basket.basketItems ?? [];
    const problems: string[] = [];
    const cap = validSpendCap(cfg);

    if (!Number.isFinite(basket.totalPrice)) problems.push("Nando's didn't return a usable basket total, so the spend cap can't be checked.");
    if (basket.status && basket.status !== "ACTIVE") problems.push(`This basket isn't open for ordering (status ${basket.status}).`);
    if (basket.orderNumber || (basket as any).orderPlacedTime) problems.push("This basket has already been placed as an order.");
    const surcharges = Array.isArray((basket as any).surcharges) ? ((basket as any).surcharges as unknown[]) : [];
    if (surcharges.length) problems.push(`The basket has surcharges this tool doesn't understand (${JSON.stringify(surcharges).slice(0, 200)}). Order on the website instead.`);
    if (items.length && basket.menuId) {
      // Lines must come from this store's menu (a store change can leave old ones behind).
      try {
        const menu = await this.loadMenu(basket);
        const stale = items.filter((i) => !menu.products.some((p) => p.id === i.productId && p.available));
        if (stale.length) problems.push(`Not available at this store: ${stale.map((i) => i.productName.trim()).join(", ")}. Remove them first.`);
      } catch (e) {
        problems.push(`Couldn't check the basket against this store's menu (${(e as Error).message}).`);
      }
    }

    if (cap === null) problems.push(`Your spend cap setting (${JSON.stringify(cfg.spendCapRands)}) isn't a valid number. Fix it with \`nandos42 cap <rands>\`.`);
    if (!cfg.storeId) problems.push("No store chosen. Use nandos_set_store first.");
    if (basket.orderType !== "COLLECTION") problems.push(`Basket is set to ${basket.orderType ?? "nothing"}, not collection. Use nandos_set_store.`);
    if (cfg.storeId && basket.storeId !== cfg.storeId) {
      problems.push(
        `Basket is at ${basket.storeName?.trim() ?? "no store"}, but your chosen store is ${cfg.storeName ?? cfg.storeId}. Use nandos_set_store, then review the basket.`,
      );
    }
    if (!items.length) problems.push("The basket is empty.");
    if (basket.totalPrice < (basket.minimumOrderValue ?? 0)) problems.push(`Below the store's minimum order of ${rands(basket.minimumOrderValue)}.`);
    if (basket.maximumOrderValue && basket.totalPrice > basket.maximumOrderValue)
      problems.push(`Above the store's maximum order of ${rands(basket.maximumOrderValue)}.`);
    if (cap !== null && basket.totalPrice > cap * 100)
      problems.push(`Total ${rands(basket.totalPrice)} is over your spend cap of R${cap}. Change it with \`nandos42 cap <rands>\` if you really mean it.`);
    const status = basket.storeCapacity?.storeStatus;
    if (status && status !== "AVAILABLE") problems.push(`Store is not taking orders right now (${status}).`);
    const prior = this.submitted.get(basket.id);
    if (prior) {
      // Already sent once from this process. Allow again only if order history shows it
      // didn't go through and either the basket changed or a few minutes have passed.
      const history = await this.api.orderHistory(10).catch(() => null);
      const placed = history?.some((h) => h.id === basket.id);
      const changed = prior.code !== fingerprint(basket, null) && prior.code !== "";
      if (history && !placed && (changed || Date.now() - prior.at > 5 * 60 * 1000)) {
        this.submitted.delete(basket.id);
      } else {
        problems.push(
          placed
            ? "This basket has already been ordered. Check nandos_order_status."
            : "This basket was sent to Nando's a moment ago and the result is unclear. Check nandos_order_status; you can try again in a few minutes if no order shows up.",
        );
      }
    }

    const requirements = await this.api.paymentRequirements();
    if (!requirements.allowUnpaidOrders) {
      problems.push(
        "Pay-on-collection isn't offered for this account/store right now, so the order would need online card payment. Finish it on nandos.co.za instead.",
      );
    }
    const intents = requirements.unpaidOrderPaymentIntents ?? [];
    let intent: Intent | null = null;
    if (opts.payAtStoreOption) {
      if (!intents.length) {
        problems.push("Nando's offers no pay-at-store options to choose from; leave pay_at_store_option out.");
      } else {
        const q = opts.payAtStoreOption.toLowerCase();
        const hits = intents.filter((i) => intentLabel(i).toLowerCase().includes(q));
        if (hits.length === 1) intent = hits[0];
        else problems.push(`pay_at_store_option "${opts.payAtStoreOption}" matches ${hits.length} options; choose one of: ${intents.map(intentLabel).join(", ")}.`);
      }
    } else if (intents.length === 1) {
      intent = intents[0];
    } else if (intents.length > 1) {
      problems.push(`Choose how you'll pay at the store with pay_at_store_option: ${intents.map(intentLabel).join(", ")}.`);
    }

    const code = fingerprint(basket, intent?.id ?? null);
    const summary = {
      customer: me.name ?? undefined,
      store: basket.storeName?.trim(),
      items: items.map((i) => `${i.quantity} x ${i.productName.trim()}${i.computedDescription ? ` (${i.computedDescription})` : ""}: ${rands(i.productPrice * i.quantity)}`),
      total: rands(basket.totalPrice),
      payment: intent ? `Pay on collection (${intentLabel(intent)})` : "Pay on collection",
      readyAround: basket.storeCapacity?.expectedTime
        ? new Date(basket.storeCapacity.expectedTime).toLocaleTimeString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit" })
        : undefined,
    };

    if (problems.length) return { placed: false as const, problems, summary };
    if (!opts.confirm) {
      return {
        placed: false as const,
        problems: [],
        summary,
        confirmationCode: code,
        note: "Preview only. To place it, call again with confirm=true and this confirmation_code.",
      };
    }
    if (opts.confirmationCode !== code) {
      return {
        placed: false as const,
        problems: ["confirmation_code doesn't match the current basket: it changed since the preview, or no preview was done. Preview again."],
        summary,
      };
    }

    // Last check, as close to the order call as possible.
    const fresh = await this.api.basket();
    if (fingerprint(fresh, intent?.id ?? null) !== code) {
      return { placed: false as const, problems: ["The basket changed just now. Preview again."], summary };
    }

    this.submitted.set(basket.id, { at: Date.now(), code: fingerprint(basket, null) });
    let tx: any;
    try {
      tx = await this.api.placeUnpaidOrder(intent?.id ?? null);
    } catch (e) {
      return {
        placed: "unknown" as const,
        problems: [
          `The order call failed (${(e as Error).message}). It MAY still have gone through. Check nandos_order_status before trying again; don't just retry.`,
        ],
        summary,
      };
    }
    this.menuCache = undefined;
    if (tx?.webFlow) {
      this.submitted.delete(basket.id);
      return { placed: false as const, problems: ["Nando's asked for a browser payment step. Finish this order on nandos.co.za."], summary };
    }
    if (!tx?.success) {
      this.submitted.delete(basket.id);
      return { placed: false as const, problems: [`Nando's declined the order: ${tx?.resultMessage ?? JSON.stringify(tx)}`], summary };
    }
    const history = await this.api.orderHistory(5).catch(() => [] as Basket[]);
    const order = history.find((h) => h.id === basket.id);
    if (tx.completed === false) {
      return {
        placed: "unknown" as const,
        problems: ["Nando's accepted the order but hasn't confirmed it as complete yet. Check nandos_order_status in a minute."],
        summary,
        order: order ? orderView(order) : undefined,
      };
    }
    return { placed: true as const, summary, order: order ? orderView(order) : undefined };
  }

  async orderStatus(count = 3) {
    return (await this.api.orderHistory(count)).map(orderView);
  }
}

export interface CheckoutOptions {
  confirm: boolean;
  confirmationCode?: string;
  payAtStoreOption?: string;
}

function intentLabel(i: Intent): string {
  for (const k of ["name", "title", "label", "description", "displayName", "type", "paymentType"]) {
    const v = (i as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return i.id;
}

/** Short hash of everything that matters about the order, so confirm=true can't place something different. */
function fingerprint(b: Basket, intentId: string | null): string {
  const items = (b.basketItems ?? [])
    .map((i) => [i.id, i.productId, i.quantity, i.productPrice, i.computedDescription ?? ""])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  const data = JSON.stringify([b.id, b.storeId, b.orderType, b.status ?? null, b.totalPrice, items, (b as any).surcharges ?? null, intentId]);
  return createHash("sha256").update(data).digest("hex").slice(0, 10);
}

export function orderView(b: Basket) {
  const t = (ms?: number | null) =>
    ms ? new Date(ms).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" }) : undefined;
  return {
    orderNumber: b.orderNumber ?? undefined,
    store: b.storeName?.trim(),
    status: b.status,
    progress: (b as any).fulfilmentProgress?.status,
    paymentStatus: (b as any).paymentStatus,
    paymentMethod: (b as any).paymentMethod,
    placed: t((b as any).orderPlacedTime),
    expectedReady: t(b.orderExpectedTime),
    total: rands(b.totalPrice),
    items: (b.basketItems ?? []).map((i) => `${i.quantity} x ${i.productName.trim()}${i.computedDescription ? ` (${i.computedDescription})` : ""}`),
  };
}

export function describeProduct(menu: Menu, p: MenuNode) {
  let from = rands(p.price);
  try {
    from = rands(selectionPrice(menu.configure(p).selection));
  } catch {
    /* keep base price */
  }
  return { id: p.id, name: p.name, category: menu.category(p), from, description: p.description };
}
