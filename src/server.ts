import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, updateConfig, validSpendCap } from "./config.js";
import { describeOptions, describeSelection, rands, selectionPrice } from "./menu.js";
import { NandosService, describeProduct } from "./service.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/** Wrap a handler so errors come back to the agent as readable tool errors. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return { ...text(`Error: ${e instanceof Error ? e.message : String(e)}`), isError: true };
    }
  };
}

const withNotices = <T extends object>(obj: T, notices: string[]) => (notices.length ? { ...obj, notices } : obj);

export function createServer(): McpServer {
  const svc = new NandosService();
  const server = new McpServer(
    { name: "nandos42", version: "0.1.0" },
    {
      instructions: [
        "Orders Nando's South Africa for COLLECTION, paid at the store on pickup. No card details are ever handled.",
        "Typical flow for 'Nando's, surprise me': nandos_surprise_me -> show the user the basket -> nandos_place_order with confirm=false (preview, returns a confirmation_code) -> nandos_place_order with confirm=true and that confirmation_code.",
        "Placing an order is a real commitment: the user must collect and pay. Unless the user clearly asked for a fully hands-off order, show them the preview and get a yes first.",
        "If nandos_place_order returns placed='unknown', do NOT retry: check nandos_order_status first.",
        "Always relay any `notices` or `warnings` in tool results to the user (e.g. a store change).",
        "If no store is set, ask the user where they are, then use nandos_find_stores (text query like a suburb or mall name works) and nandos_set_store.",
      ].join("\n"),
    },
  );

  server.registerTool(
    "nandos_status",
    {
      title: "Account & settings",
      description: "Shows whether a Nando's account is linked, the selected store, home location and spend cap.",
      inputSchema: {},
    },
    safe(async () => {
      const cfg = loadConfig();
      let account: unknown = "not logged in (browsing anonymously; run `nandos42 login` in a terminal to enable ordering)";
      if (cfg.credentials) {
        try {
          const me = await svc.api.me();
          account = { linked: true, name: me.name, verified: me.verified };
        } catch (e) {
          account = { linked: true, problem: (e as Error).message };
        }
      }
      return text({
        account,
        store: cfg.storeName ?? null,
        storeId: cfg.storeId ?? null,
        home: cfg.home ? { label: cfg.home.label ?? "saved" } : null,
        spendCapRands: validSpendCap(cfg) ?? `invalid (${JSON.stringify(cfg.spendCapRands)}): ordering is blocked until fixed`,
      });
    }),
  );

  server.registerTool(
    "nandos_set_home",
    {
      title: "Save home location",
      description: "Saves a default location used to find the nearest store.",
      inputSchema: { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().optional() },
    },
    safe(async ({ lat, lng, label }) => {
      updateConfig({ home: { lat, lng, label } });
      return text(`Saved home location${label ? ` (${label})` : ""}.`);
    }),
  );

  server.registerTool(
    "nandos_find_stores",
    {
      title: "Find stores",
      description:
        "Finds Nando's stores that do collection. Use `query` for a suburb/mall/name (e.g. 'Sandton', 'Canal Walk'), or lat AND lng. With no arguments uses the saved home location.",
      inputSchema: {
        query: z.string().optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        radius_km: z.number().positive().max(100).optional(),
      },
    },
    safe(async ({ query, lat, lng, radius_km }) => {
      const stores = await svc.findStores({ query, lat, lng, radiusKm: radius_km });
      if (!stores.length) return text("No collection stores found. Try a wider radius or a different search.");
      return text(
        stores.slice(0, 10).map((s) => ({
          id: s.id,
          name: (s.displayName ?? s.name).trim(),
          address: s.address,
          distanceKm: s.distance !== undefined ? Math.round(s.distance * 10) / 10 : undefined,
          status: s.capacity?.storeStatus,
          phone: s.phone?.[0],
        })),
      );
    }),
  );

  server.registerTool(
    "nandos_set_store",
    {
      title: "Choose store",
      description: "Sets the store to collect from (switches the basket to collection at that store). Use an id from nandos_find_stores.",
      inputSchema: { store_id: z.string() },
    },
    safe(async ({ store_id }) => {
      const { basket: b, notices } = await svc.setStore(store_id);
      return text(
        withNotices(
          { collectingFrom: b.storeName?.trim(), basketItems: b.basketItems?.length ?? 0, basketTotal: rands(b.totalPrice) },
          notices,
        ),
      );
    }),
  );

  server.registerTool(
    "nandos_menu",
    {
      title: "Browse menu",
      description: "Lists what's available at the selected store. Filter by category (e.g. 'Burgers', 'Classics', 'Drinks') or search text.",
      inputSchema: { search: z.string().optional(), category: z.string().optional() },
    },
    safe(async ({ search, category }) => {
      const { menu, notices } = await svc.menu();
      let items = search ? menu.find(search) : menu.orderable;
      if (category) items = items.filter((p) => menu.category(p).toLowerCase().includes(category.toLowerCase()));
      if (!search && !category) {
        const cats = new Map<string, number>();
        for (const p of items) cats.set(menu.category(p), (cats.get(menu.category(p)) ?? 0) + 1);
        return text(withNotices({ hint: "Pass category or search to list items.", categories: Object.fromEntries(cats) }, notices));
      }
      return text(withNotices({ items: items.slice(0, 40).map((p) => describeProduct(menu, p)) }, notices));
    }),
  );

  server.registerTool(
    "nandos_item_options",
    {
      title: "Item options",
      description: "Shows the choices for a menu item (flavour, sides, drinks, extras) so you can pass exact option names to nandos_add_item.",
      inputSchema: { product: z.string().describe("Product name or id") },
    },
    safe(async ({ product }) => {
      const { menu, notices } = await svc.menu();
      const p = menu.resolve(product);
      const head = notices.length ? `NOTICE: ${notices.join(" ")}\n\n` : "";
      return text(`${head}${p.name} (${rands(p.price)} base)\n${p.description ?? ""}\n\n${describeOptions(p) || "No options."}`);
    }),
  );

  server.registerTool(
    "nandos_add_item",
    {
      title: "Add to basket",
      description:
        "Adds a menu item. `options` are option names to choose, e.g. ['Hot', 'PERi-PERi Chips', 'Coke (Buddy)']; each is used once, so list a side twice to get it twice. Any option that matches nothing is an error (nothing is added). Unspecified required choices get the first free option, so check `choices` in the result.",
      inputSchema: {
        product: z.string().describe("Product name or id"),
        options: z.array(z.string()).optional(),
        avoid: z.array(z.string()).optional(),
        quantity: z.number().int().min(1).max(20).optional(),
      },
    },
    safe(async ({ product, options, avoid, quantity }) => {
      const r = await svc.addItem(product, { wants: options, avoid }, quantity ?? 1);
      return text(
        withNotices(
          {
            added: `${quantity ?? 1} x ${r.node.name}`,
            choices: r.description,
            basket: (r.basket.basketItems ?? []).map((i) => `${i.quantity} x ${i.productName.trim()}`),
            basketTotal: rands(r.basket.totalPrice),
          },
          r.notices,
        ),
      );
    }),
  );

  server.registerTool(
    "nandos_surprise_me",
    {
      title: "Surprise me",
      description:
        "Picks a random but sensible order from the selected store's live menu and puts it in the basket (replacing what's there by default). Does NOT place the order.",
      inputSchema: {
        people: z.number().int().min(1).max(12).optional(),
        budget_rands: z.number().positive().optional().describe("Default: about R200 per person. Never above the spend cap."),
        heat: z.enum(["lemon-herb", "mild", "hot", "xtra-hot", "any"]).optional(),
        drinks: z.boolean().optional().describe("Include a drink per person (default true)"),
        dessert: z.boolean().optional(),
        vegetarian: z.boolean().optional(),
        avoid: z.array(z.string()).optional().describe("Words to avoid, e.g. ['coleslaw', 'bbq']"),
        wants: z.array(z.string()).optional().describe("Things to steer towards, e.g. ['halloumi', 'wedges']"),
        replace_basket: z.boolean().optional(),
      },
    },
    safe(async (a) => {
      const { plan, basket, notices } = await svc.surprise({
        people: a.people,
        budgetRands: a.budget_rands,
        heat: a.heat,
        drinks: a.drinks,
        dessert: a.dessert,
        vegetarian: a.vegetarian,
        avoid: a.avoid,
        wants: a.wants,
        replaceBasket: a.replace_basket,
      });
      return text(
        withNotices(
          {
            surprise: plan.items.map((it) => {
              const choices = describeSelection(it.selection);
              return `${it.quantity} x ${it.selection.node.name}${choices ? ` (${choices})` : ""}: ${rands(selectionPrice(it.selection) * it.quantity)}`;
            }),
            store: basket.storeName?.trim(),
            basketTotal: rands(basket.totalPrice),
            next: "Show this to the user, then nandos_place_order with confirm=false for a preview.",
          },
          notices,
        ),
      );
    }),
  );

  server.registerTool(
    "nandos_view_basket",
    { title: "View basket", description: "Shows the current basket. Read-only.", inputSchema: {} },
    safe(async () => {
      const { basket: b, warnings } = await svc.viewBasket();
      const view = {
        store: b.storeName?.trim() ?? null,
        items: (b.basketItems ?? []).map((i) => ({
          basketItemId: i.id,
          item: `${i.quantity} x ${i.productName.trim()}`,
          choices: i.computedDescription,
          price: rands(i.productPrice * i.quantity),
        })),
        total: rands(b.totalPrice),
      };
      return text(warnings.length ? { ...view, warnings } : view);
    }),
  );

  server.registerTool(
    "nandos_remove_item",
    {
      title: "Remove from basket",
      description: "Removes one basket line (basketItemId from nandos_view_basket), or everything with all=true.",
      inputSchema: { basket_item_id: z.string().optional(), all: z.boolean().optional() },
    },
    safe(async ({ basket_item_id, all }) => {
      const b = all ? await svc.clearBasket() : basket_item_id ? await svc.removeItem(basket_item_id) : null;
      if (!b) return text("Pass basket_item_id or all=true.");
      return text(`Basket now has ${b.totalItems} item(s), total ${rands(b.totalPrice)}.`);
    }),
  );

  server.registerTool(
    "nandos_place_order",
    {
      title: "Place order (pay on collection)",
      description:
        "Places the basket as a collection order, paid at the store. confirm=false returns a preview and a confirmation_code. confirm=true needs that exact code; if the basket, store or payment option changed since the preview it is refused. Refused above the user's spend cap. If the result is placed='unknown', check nandos_order_status; never retry blindly.",
      inputSchema: {
        confirm: z.boolean(),
        confirmation_code: z.string().optional(),
        pay_at_store_option: z.string().optional().describe("Required only if the preview asks you to choose (e.g. 'cash' or 'card')"),
      },
      annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: false },
    },
    safe(async ({ confirm, confirmation_code, pay_at_store_option }) => {
      const r = await svc.checkout({ confirm, confirmationCode: confirmation_code, payAtStoreOption: pay_at_store_option });
      return text(r);
    }),
  );

  server.registerTool(
    "nandos_order_status",
    { title: "Order status", description: "Shows your most recent orders and their status.", inputSchema: { count: z.number().int().min(1).max(10).optional() } },
    safe(async ({ count }) => text(await svc.orderStatus(count ?? 3))),
  );

  return server;
}

export async function serve(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
