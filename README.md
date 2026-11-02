# Simply Veggie MCP

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io/) server for one [Simply Veggie](https://simplyveggie.co.in) account: search your price list, build the cart from a shopping list, track orders and download invoices.

**Independent project; not affiliated with Simply Veggie / Future Veggies India.** Use an account you own or are authorized to operate.

**It never places orders or pays.** There is no order-placement tool. Prepare the cart through MCP, then review and place the order on the website or app.

Structure follows [hyperpure-mcp](https://github.com/karthikbala/hyperpure-mcp). Simply Veggie uses phone + password login and a JSON API, so this server needs no browser.

## Tools

| Tool                | Purpose                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `session_status`    | Sign in if needed; report the account and its price list.                                    |
| `list_categories`   | Category tree, with ids for filtering search.                                                |
| `search_products`   | Name/category search: price, pack size (`unit`, `packKg`), availability and stock.           |
| `add_to_cart`       | Add several items at once, by packs (`quantity`) or weight (`weightKg`, converted to packs). |
| `set_cart_quantity` | Set one item's exact quantity; `0` removes it.                                               |
| `get_cart`          | Cart lines with packs, total weight, rate and line total; cart total.                        |
| `list_orders`       | Orders with status, delivery/payment status and totals.                                      |
| `track_order`       | One order by its number: timeline, slot, payment, items ordered vs delivered/returned.       |
| `get_invoice`       | Invoice download link (valid 30 minutes), optionally the PDF itself.                         |

Every cart change is checked against the account's catalogue first and verified by re-reading the cart. Weight that isn't a whole number of packs is refused with the nearest options (for example 1.1 kg of a 0.25 kg pack suggests 1 kg or 1.25 kg).

## Connect

The server accepts two kinds of credentials on `https://YOUR_DOMAIN/mcp`:

- **OAuth** (ChatGPT, Claude custom connectors): the app registers itself, then opens a consent page where you enter `OWNER_KEY` once. Tokens last an hour and renew automatically for 90 days.
- **Static bearer token** (`MCP_TOKEN`) for clients that can send headers: Claude Desktop config, Claude Code, Cursor, scripts.

### ChatGPT

1. ChatGPT (web) → **Plugins** → **+** → **Add custom MCP server**.
2. Name `Simply Veggie`, Server URL `https://YOUR_DOMAIN/mcp`, Authentication **OAuth** (leave client credentials empty: ChatGPT registers itself).
3. Accept the risk notice → **Create**. On the consent page, enter the owner key → **Allow access**.
4. In a chat, type `@Simply Veggie` and ask, for example: _"Add 2 kg tomato, 1 kg onion and 3 bunches coriander to my cart"_.

### Claude (claude.ai, Desktop, mobile)

1. **Settings → Connectors** (Team/Enterprise: **Organization settings → Connectors**) → **Add custom connector**.
2. Name `Simply Veggie`, URL `https://YOUR_DOMAIN/mcp` → **Continue**.
3. Authentication: **Sign in now**; OAuth client: **Register automatically** → **Add**.
4. On the consent page, enter the owner key → **Allow access**. Enable the connector in a chat from the tools menu.

### Claude Desktop config, Claude Code, Cursor (bearer token)

```json
{
  "mcpServers": {
    "simplyveggie": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://YOUR_DOMAIN/mcp",
        "--header",
        "Authorization:${AUTH}"
      ],
      "env": { "AUTH": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

Claude Code: `claude mcp add --transport http simplyveggie https://YOUR_DOMAIN/mcp --header "Authorization: Bearer YOUR_MCP_TOKEN"`. Cursor: `"url"` plus `"headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }`.

## Run

Node.js 22.9+.

```sh
npm ci
cp .env.example .env   # PUBLIC_ORIGIN, MCP_TOKEN, OWNER_KEY, SIMPLYVEGGIE_PHONE, SIMPLYVEGGIE_PASSWORD
npm start
```

**Config from Infisical (optional).** Set `INFISICAL_URL`, `INFISICAL_PROJECT_ID`, `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` (a universal-auth machine identity with read access to that project only; `INFISICAL_ENVIRONMENT` defaults to `prod`) and keep every other value in Infisical. The server reads them at startup and checks every minute; when a value changes it restarts itself to apply it. Keys absent from Infisical fall back to the environment.

Listens on `127.0.0.1:9320`; put it behind HTTPS at the origin root (OAuth discovery lives under `/.well-known/`). The Simply Veggie session cookie and OAuth clients/tokens (hashed) are stored in `DATA_DIR` with owner-only permissions. Docker: `docker-compose.yml` keeps `DATA_DIR` on a volume.

## Development

```sh
npm test                                                     # offline unit tests
BASE=http://127.0.0.1:9320 OWNER_KEY=... node test/oauth-flow.mjs   # OAuth end-to-end against a running server
```

## License

[MIT](LICENSE).
