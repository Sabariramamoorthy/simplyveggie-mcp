# Simply Veggie MCP

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io/) server for one [Simply Veggie](https://simplyveggie.co.in) account: search your price list, prepare a cart, and read orders and invoices.

**Independent project; not affiliated with Simply Veggie / Future Veggies India.** Use an account you own or are authorized to operate.

**It never places orders or pays.** The server has no order-placement tool. Prepare the cart through MCP, then review and place the order yourself on the website or app.

Structure follows [hyperpure-mcp](https://github.com/karthikbala/hyperpure-mcp). Unlike Hyperpure, Simply Veggie uses phone + password login and a JSON API, so this server needs no browser: it calls the same API the website uses.

## Tools

| Tool                | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `session_status`    | Sign in if needed; report the account and its catalogue (price list). |
| `list_categories`   | Category tree of the account's catalogue.                             |
| `search_products`   | Search by name and/or category; prices are the account's price list.  |
| `get_cart`          | Current cart, quantities and totals.                                  |
| `set_cart_quantity` | Set a product's absolute quantity; `0` removes it.                    |
| `list_orders`       | Orders, newest first, paginated.                                      |
| `get_order`         | One order's items, amounts and status.                                |
| `download_invoice`  | Invoice PDF for an order.                                             |

## Run

Node.js 22.9+.

```sh
npm ci
cp .env.example .env   # fill in PUBLIC_ORIGIN, MCP_TOKEN, SIMPLYVEGGIE_PHONE, SIMPLYVEGGIE_PASSWORD
npm start
```

The server listens on `127.0.0.1:9320` and must sit behind HTTPS. `/healthz` reports process health and whether credentials are configured, not whether login succeeds: call `session_status` for that.

The login session cookie is stored in `DATA_DIR/session.json` (owner-only permissions) and renewed automatically when it expires. Wrong credentials fail once with `LOGIN_FAILED`; the server does not retry in a loop.

Docker: `docker-compose.yml` builds the image and keeps `DATA_DIR` on a volume.

## Connect

```json
{
  "mcpServers": {
    "simplyveggie": {
      "url": "https://YOUR_DOMAIN/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

Bearer authentication only, not OAuth.

## Development

```sh
npm test
```

Tests run offline against a fake site (login, session renewal, cart add/update/remove, product mapping).

## License

[MIT](LICENSE).
