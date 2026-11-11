# nandos42 🐔🔥

An MCP server that lets your AI agent order Nando's (South Africa) for collection.

> **You:** Nando's, surprise me. Two of us, extra hot, under R300.
> **Agent:** Got you a 1/4 Chicken + PERi-PERi Wedges and a Chicken Burger + Spicy Rice, both Xtra Hot, two Cokes. R251 at Sandton City, ready around 18:40, pay when you collect. Place it?
> **You:** Do it.

Orders are **collection, paid at the store** (Nando's "Pay on Collection"), so the server never touches card details.

> ⚠️ **Unofficial.** This talks to the private API behind nandos.co.za/eat/order, which was reverse-engineered for fun. It isn't affiliated with or endorsed by Nando's, may break whenever they change their site, and using it may be against their terms of service. Every order it places is a real order you have to collect and pay for.

## Setup

Requires Node 20+.

```bash
git clone https://github.com/h-strydom/nandos42.git
cd nandos42
npm install
npm run build
```

### Link your Nando's account

You can browse menus and build a basket anonymously. To place orders you need to link your account:

```bash
node dist/cli.js login
```

Nando's login is protected by reCAPTCHA, so instead of automating it, you log in once in your browser and paste the session it creates. The command walks you through it (log in on the website, then run `copy(localStorage.getItem('nandos-credentials-web'))` in DevTools). The token is stored in `~/.nandos42/config.json` and refreshed automatically.

Your account needs "Pay on Collection" available. If Nando's only offers card payment, `nandos_place_order` will tell you so and refuse.

### Optional settings

```bash
node dist/cli.js cap 400                 # max order total the agent may place (default R500)
node dist/cli.js home -26.1076 28.0567   # your location, for "nearest store"
node dist/cli.js status
```

### Add it to your agent

**Claude Code**

```bash
claude mcp add nandos42 -- node /absolute/path/to/nandos42/dist/cli.js
```

**Claude Desktop** (`claude_desktop_config.json`), or any other MCP client:

```json
{
  "mcpServers": {
    "nandos42": {
      "command": "node",
      "args": ["/absolute/path/to/nandos42/dist/cli.js"]
    }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `nandos_status` | Linked account, selected store, home, spend cap |
| `nandos_find_stores` | Find collection stores by text (`"Canal Walk"`) or lat/lng |
| `nandos_set_store` | Choose the store to collect from |
| `nandos_set_home` | Save a default location |
| `nandos_menu` | Browse the store's live menu by category or search |
| `nandos_item_options` | See an item's choices (flavour, piece, side, drink, extras) |
| `nandos_add_item` | Add an item, e.g. `options: ["Xtra Hot", "PERi-PERi Wedges", "Coke (Buddy)"]` |
| `nandos_surprise_me` | Random but sensible order for N people: heat, budget, vegetarian, drinks, dessert, avoid list |
| `nandos_view_basket` / `nandos_remove_item` | Inspect or edit the basket |
| `nandos_place_order` | Preview (`confirm: false`), then place (`confirm: true` + the preview's `confirmation_code`) |
| `nandos_order_status` | Recent orders and their status |

### Safety rails

- **Preview first.** `nandos_place_order` with `confirm: false` returns a short `confirmation_code`, a hash of the basket id, store, every line (item, options, quantity, price), the total and the pay-at-store option. `confirm: true` must pass that code back. If anything changed since the preview, the order is refused. The basket is checked again right before the order call.
- **Your store only.** Checkout never switches stores or edits the basket. If the basket on Nando's side points at a different store than the one you chose (e.g. you changed it on the website), it refuses and tells you. Each store has its own menu, so changing store removes basket items the new store doesn't have (with a notice), and checkout refuses any line that isn't on the current store's menu.
- **Open baskets only.** Checkout refuses a basket that isn't `ACTIVE`, that already has an order number, or that has surcharges it doesn't understand.
- **Spend cap.** Orders above your cap (`nandos42 cap`, default R500) are refused. A corrupt config file or a non-numeric cap blocks ordering; it never silently falls back to the default.
- **No double orders.** Basket changes and checkout run one at a time. A basket that was already sent is never sent again from the same session. If the order call times out, the result is `placed: "unknown"` and tells the agent to check `nandos_order_status` instead of retrying.
- **Pay on collection only.** If Nando's wants a card or 3-D Secure step, it stops and tells you to finish on the website. If there are several pay-at-store options, you must pick one.
- **No silent substitutions.** `nandos_add_item` refuses vague product names ("chicken" could be a dozen things) and any option that matches nothing on the item ("Extra Hot" and "Xtra Hot" both work). Each option you name fills one choice, in the order you give them, so "cheese" adds Add Cheese and not Double Cheese as well. "onion" never selects "No Onion". Tool results include `notices` whenever the server changed something for you, such as picking a store.
- The server instructions tell the agent to show you the preview and get a yes first, unless you explicitly asked for a hands-off order.

Your login token is stored in plain text in `~/.nandos42/config.json`. It's chmod 600 on macOS/Linux; Windows ignores that, so it relies on your user-profile permissions.

## How it works

The Nando's SA web app is a Vue SPA on top of a JSON API at `https://api.nandos.co.za/api`:

- **Auth:** `POST /auth/login/anonymous` for browsing. Real sessions come from the website and are refreshed with `GET /auth/extend`. Requests carry the token in a `Nandos-Auth` header plus `Nandos-App-Context: WEB`, and tokens are bound to the User-Agent they were issued to.
- **Stores:** `GET /stores/locate?lat&lng&orderType=COLLECTION` and `GET /stores`.
- **Basket:** `PUT /customers/me/basket {orderType: "COLLECTION", storeId}` attaches the store's `menuId`. Items go in with `POST /customers/me/basket/items`.
- **Menu:** `GET /v2/pack/menu/{menuId}` returns product trees (combo → main → flavour group → options). Store availability comes from `GET /v2/pack/product-exclusion?basketId=`.
- **Item payload:** the tree of selected nodes, `{productId, quantity, computedDescription, children: [{productId, children}]}`. A group's `quantity` is how many of its children can be picked; `mandatory` groups need a pick.
- **Checkout:** `GET /customers/me/payment/prepare/food` says whether `allowUnpaidOrders` is on. If so, `POST /customers/me/payment/initiate/food {skipCreditCardPayment: true, ...}` places it as Pay on Collection.

`src/menu.ts` holds the product-tree model and the configurator that turns "Xtra Hot, wedges, Coke" into a valid selection. `src/surprise.ts` is the meal planner.

## License

MIT. Not affiliated with Nando's.
