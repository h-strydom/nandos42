/**
 * Thin client for the (unofficial, undocumented) Nando's South Africa ordering API
 * that powers https://www.nandos.co.za/eat/order.
 */
import { type Config, type Credentials, loadConfig, saveConfig } from "./config.js";
import type { RawMenu } from "./menu.js";

const BASE = "https://api.nandos.co.za/api";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const REFRESH_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;

export class NandosError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

/** Tokens are bound to the User-Agent they were issued to (the `device` claim). */
function deviceOf(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.device === "string" ? payload.device : undefined;
  } catch {
    return undefined;
  }
}

export interface Store {
  id: string;
  name: string;
  displayName?: string;
  code?: string;
  address?: string;
  distance?: number;
  latitude?: number;
  longitude?: number;
  phone?: string[];
  collectionCapable?: boolean;
  capacity?: { storeStatus?: string; expectedTime?: number };
}

export interface BasketItem {
  id: string;
  productId: string;
  productName: string;
  productPrice: number;
  computedDescription?: string;
  quantity: number;
  subItems?: unknown[];
}

export interface Basket {
  id: string;
  orderType: string | null;
  storeId: string | null;
  storeName: string | null;
  menuId: string | null;
  totalPrice: number;
  totalItems: number;
  minimumOrderValue: number;
  maximumOrderValue: number | null;
  basketItems: BasketItem[] | null;
  storeCapacity?: { storeStatus?: string; expectedTime?: number } | null;
  status?: string;
  orderNumber?: string | number | null;
  orderExpectedTime?: number | null;
  [k: string]: unknown;
}

export interface Customer {
  id: string;
  anonymous: boolean;
  verified?: boolean;
  /** First name (the API calls it `name`). */
  name?: string;
  lastName?: string;
  mobilePhoneNumber?: string;
  [k: string]: unknown;
}

export interface PaymentRequirements {
  enabled?: boolean;
  allowUnpaidOrders?: boolean;
  unpaidOrderPaymentIntents?: Array<{ id: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface BasketChildPayload {
  productId: string;
  children?: BasketChildPayload[];
}

export interface BasketItemPayload extends BasketChildPayload {
  quantity: number;
  computedDescription: string;
}

/** Ids from the API are UUIDs; anything else must never reach a URL path ("../.." traversal). */
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
function safeId(id: string, what: string): string {
  if (!ID_RE.test(id)) throw new NandosError(`Invalid ${what}: ${JSON.stringify(id).slice(0, 80)}`);
  return encodeURIComponent(id);
}

const TIMEOUT_MS = 20_000;
const REFRESH_BACKOFF_MS = 60 * 60 * 1000;

export class NandosApi {
  /** Credentials being validated by importCredentials, not yet saved. */
  private candidate?: Credentials;
  /** Shared in-flight login/refresh so parallel calls don't each create a session. */
  private authInFlight?: Promise<Credentials>;
  private lastRefreshFailure = 0;

  private credentials(): Promise<Credentials> {
    if (this.candidate) return Promise.resolve(this.candidate);
    if (this.authInFlight) return this.authInFlight;
    const cfg = loadConfig();
    const real = cfg.credentials;
    const now = Date.now();
    if (real) {
      const due = real.expiry - now < REFRESH_WITHIN_MS && now - this.lastRefreshFailure > REFRESH_BACKOFF_MS;
      if (!due) return Promise.resolve(real);
      return this.single(() => this.refresh(real));
    }
    if (cfg.anonymous && cfg.anonymous.expiry - now >= REFRESH_WITHIN_MS) return Promise.resolve(cfg.anonymous);
    return this.single(() => this.anonymousLogin());
  }

  private single(fn: () => Promise<Credentials>): Promise<Credentials> {
    this.authInFlight ??= fn().finally(() => {
      this.authInFlight = undefined;
    });
    return this.authInFlight;
  }

  private persist(patch: Partial<Config>) {
    saveConfig({ ...loadConfig(), ...patch });
  }

  private async anonymousLogin(): Promise<Credentials> {
    const res = await fetch(`${BASE}/auth/login/anonymous`, {
      method: "POST",
      headers: { Accept: "application/json", "User-Agent": DEFAULT_UA, "Nandos-App-Context": "WEB" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: any = await res.json().catch(() => null);
    const creds: Credentials | undefined = body?.data?.credentials;
    if (!res.ok || !creds?.token) throw new NandosError(`Anonymous login failed (${res.status})`, res.status);
    this.persist({ anonymous: creds });
    return creds;
  }

  /** Refresh a real login. Failures keep using the token while it is still valid. */
  private async refresh(creds: Credentials): Promise<Credentials> {
    let fresh: Credentials | undefined;
    let status: number | undefined;
    try {
      const res = await fetch(`${BASE}/auth/extend`, { headers: this.headers(creds), signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = res.status;
      const body: any = await res.json().catch(() => null);
      if (res.ok) fresh = body?.data?.credentials;
    } catch {
      /* network error: treated like a failed refresh below */
    }
    if (fresh?.token) {
      this.persist({ credentials: fresh });
      return fresh;
    }
    this.lastRefreshFailure = Date.now();
    if (creds.expiry > Date.now()) return creds;
    this.persist({ credentials: undefined });
    throw new NandosError("Your Nando's login has expired. Run `nandos42 login` to import a fresh one.", status, "AUTH_EXPIRED");
  }

  private headers(creds: Credentials): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": deviceOf(creds.token) ?? DEFAULT_UA,
      "Nandos-Auth": creds.token,
      "Nandos-App-Context": "WEB",
      "Nandos-App-Version": "",
      Origin: "https://www.nandos.co.za",
      Referer: "https://www.nandos.co.za/",
    };
  }

  async request<T = any>(method: string, path: string, body?: unknown, opts: { retried?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const creds = await this.credentials();
    const usingAnon = !this.candidate && !loadConfig().credentials;
    let res: Response;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: this.headers(creds),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError";
      throw new NandosError(`Nando's API ${method} ${path} ${timedOut ? "timed out" : `failed: ${(e as Error).message}`}`, undefined, timedOut ? "TIMEOUT" : "NETWORK");
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || json?.status === "error") {
      const code: string | undefined = json?.error?.code;
      const authProblem = res.status === 401 || !!code?.startsWith("AUTH_TOKEN");
      // An expired/recycled anonymous session: get a new one and retry once (GETs only;
      // a new session has an empty basket, so replaying a write would be wrong).
      // Only drop the session we actually used, so two parallel 401s can't wipe a
      // fresh session another call just created.
      const dropAnon = () => {
        if (loadConfig().anonymous?.token === creds.token) this.persist({ anonymous: undefined });
      };
      if (usingAnon && authProblem && !opts.retried && method === "GET") {
        dropAnon();
        return this.request<T>(method, path, body, { ...opts, retried: true });
      }
      if (usingAnon && authProblem) {
        dropAnon();
        throw new NandosError("The anonymous Nando's session expired; your basket was reset. Please try again.", res.status, code);
      }
      if (!usingAnon && authProblem) {
        throw new NandosError("Nando's rejected your login token. Run `nandos42 login` to import a fresh one.", res.status, code);
      }
      const msg = json?.error?.message || json?.message || text.slice(0, 200) || res.statusText;
      throw new NandosError(`Nando's API ${method} ${path} failed (${res.status}): ${msg}`, res.status, code);
    }
    if (json === null || typeof json !== "object") {
      throw new NandosError(`Nando's API ${method} ${path} returned an unexpected response (${res.status}, not JSON).`, res.status, "BAD_RESPONSE");
    }
    return (json.data ?? json) as T;
  }

  // ---- customer -------------------------------------------------------

  async me(): Promise<Customer> {
    return (await this.request<{ customer: Customer }>("GET", "/customers/me")).customer;
  }

  /** Validate and store credentials copied from the website's localStorage. Keeps the chosen store. */
  async importCredentials(creds: Credentials): Promise<Customer> {
    this.candidate = creds;
    try {
      const me = await this.me();
      if (me.anonymous) throw new NandosError("Those credentials are for an anonymous (logged-out) session. Log in on the website first.");
      this.persist({ credentials: creds });
      return me;
    } finally {
      this.candidate = undefined;
    }
  }

  logout(): void {
    this.persist({ credentials: undefined });
  }

  // ---- stores ---------------------------------------------------------

  async locateStores(lat: number, lng: number, radiusKm = 10): Promise<Store[]> {
    const q = new URLSearchParams({
      lat: String(lat),
      lng: String(lng),
      radius: String(radiusKm),
      orderType: "COLLECTION",
      orderTime: "0",
      orderChannel: "WEB",
    });
    return (await this.request<{ stores: Store[] }>("GET", `/stores/locate?${q}`)).stores ?? [];
  }

  async allStores(): Promise<Store[]> {
    const out: Store[] = [];
    for (let page = 0; page < 20; page++) {
      const data = await this.request<any>("GET", `/stores?pageNumber=${page}&pageSize=100`);
      const stores: Store[] = data.stores ?? data.content ?? [];
      out.push(...stores);
      const totalPages = data.totalPages ?? 1;
      if (page + 1 >= totalPages || stores.length === 0) break;
    }
    return out;
  }

  // ---- basket ---------------------------------------------------------

  async configureCollection(storeId: string): Promise<Basket> {
    safeId(storeId, "store id");
    await this.request("PUT", "/customers/me/basket", { orderType: "COLLECTION", storeId });
    return this.basket(); // the PUT response omits basketItems
  }

  async basket(): Promise<Basket> {
    return (await this.request<{ basket: Basket }>("GET", "/customers/me/basket")).basket;
  }

  async addItem(item: BasketItemPayload): Promise<Basket> {
    await this.request("POST", "/customers/me/basket/items", item);
    return this.basket(); // the POST response omits basketItems, which callers rely on
  }

  async removeItem(basketItemId: string): Promise<Basket> {
    await this.request("DELETE", `/customers/me/basket/items/${safeId(basketItemId, "basket item id")}`);
    return this.basket(); // the DELETE response omits basketItems
  }

  async menu(menuId: string | null): Promise<RawMenu> {
    return (await this.request<{ menu: RawMenu }>("GET", `/v2/pack/menu/${menuId ? safeId(menuId, "menu id") : "default"}`)).menu;
  }

  /** Product definition ids that are hidden/unavailable for this basket's store. */
  async exclusions(basketId: string): Promise<Set<string>> {
    const data = await this.request<{ productExclusions: Record<string, string[]> }>(
      "GET",
      `/v2/pack/product-exclusion?basketId=${safeId(basketId, "basket id")}`,
    );
    return new Set(Object.values(data.productExclusions ?? {}).flat());
  }

  // ---- checkout -------------------------------------------------------

  async paymentRequirements(): Promise<PaymentRequirements> {
    return (await this.request<{ requirements: PaymentRequirements }>("GET", "/customers/me/payment/prepare/food")).requirements;
  }

  /** "Pay on collection": places the order without taking a card payment. Never retried. */
  async placeUnpaidOrder(unpaidOrderPaymentIntentId: string | null): Promise<any> {
    const data = await this.request<{ transaction: any }>(
      "POST",
      "/customers/me/payment/initiate/food",
      {
        walletAmount: 0,
        tipAmount: 0,
        skipCreditCardPayment: true,
        creditCard: null,
        saveCard: null,
        unpaidOrderPaymentIntentId,
      },
      { timeoutMs: 45_000 },
    );
    return data.transaction;
  }

  async orderHistory(pageSize = 5): Promise<Basket[]> {
    const data = await this.request<any>("GET", `/customers/me/basket/history?pageNumber=0&pageSize=${pageSize}`);
    return data.baskets ?? data.content ?? data.history ?? [];
  }
}
