import { ServiceError } from './core.js';

export const SITE = 'https://simplyveggie.co.in';
export const API = 'https://api.simplyveggie.co.in';
export const SEARCH =
  'https://search-search1-prod-presto-apps-o4w62cxnvxf3ko57g34sausxom.ap-south-1.es.amazonaws.com';
export const MERCHANT_ID = '67d3f56d9dcd194167425e6e';
export const APP_ID = '67d7d0899dcd19056829bc6d';

const TIMEOUT_MS = 30_000;
const number = (value) =>
  value === null || value === undefined || value === '' ? null : Number(value);

export function product(source) {
  const other = source.other_data || {};
  return {
    id: source.id,
    name: source.name,
    categoryId: source.category_id,
    price: number(source.price?.total_price),
    basePrice: number(source.price?.base_price),
    tax: number(source.price?.tax),
    unit: [other.display_quantity, other.display_name].filter(Boolean).join(' ') || null,
    available: Boolean(source.is_available) && !source.sold_out,
    stock: number(source.stock_count),
    onOffer: other.on_offer === '1' || source.on_offer === true,
    oldPrice: number(other.old_price),
    variations: (source.variations || []).map((v) => ({
      id: v.id,
      name: v.name,
      price: number(v.price?.total_price ?? v.price),
    })),
    imageUrl: source.pic_url || null,
  };
}

/**
 * Single-account Simply Veggie API client. The site authenticates with a session cookie set by
 * `/users/sign_in.json`; the jar is persisted so restarts don't log in again.
 */
export class SimplyVeggieClient {
  constructor({ phone, password, store, fetchImpl = fetch }) {
    this.phone = phone;
    this.password = password;
    this.store = store;
    this.fetch = fetchImpl;
    this.cookies = new Map();
    this.user = null;
    this.catalog = null;
  }

  async init() {
    for (const [name, value] of Object.entries(await this.store.read('session', {})))
      this.cookies.set(name, value);
  }

  get configured() {
    return Boolean(this.phone && this.password);
  }

  async absorb(response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (!setCookies.length) return;
    for (const header of setCookies) {
      const [pair, ...attributes] = header.split(';');
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index).trim(),
        value = pair.slice(index + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    await this.store.write('session', Object.fromEntries(this.cookies));
  }

  async send(method, path, { body, accept = 'application/json' } = {}) {
    const headers = {
      Accept: accept,
      Origin: SITE,
      Referer: `${SITE}/`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(this.cookies.size
        ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
        : {}),
    };
    let response;
    try {
      response = await this.fetch(`${API}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ServiceError(
        'SITE_UNAVAILABLE',
        'Simply Veggie did not respond; try again shortly.',
      );
    }
    await this.absorb(response);
    return response;
  }

  async login() {
    if (!this.configured)
      throw new ServiceError(
        'CREDENTIALS_MISSING',
        'Set SIMPLYVEGGIE_PHONE and SIMPLYVEGGIE_PASSWORD on the server.',
      );
    this.cookies.clear();
    const response = await this.send('POST', '/users/sign_in.json', {
      body: {
        user: {
          login: this.phone,
          password: this.password,
          app_id: APP_ID,
          merchant_id: MERCHANT_ID,
        },
      },
    });
    if (response.status === 401 || response.status === 422)
      throw new ServiceError(
        'LOGIN_FAILED',
        'Simply Veggie rejected the configured phone number or password.',
      );
    if (!response.ok)
      throw new ServiceError('SITE_UNAVAILABLE', `Login failed (HTTP ${response.status}).`);
    this.user = await response.json().catch(() => null);
    this.catalog = null;
  }

  /** Authenticated request; logs in once more if the session has expired. */
  async request(method, path, options = {}) {
    let response = await this.send(method, path, options);
    if (response.status === 401) {
      await this.login();
      response = await this.send(method, path, options);
    }
    if (response.status === 401)
      throw new ServiceError('LOGIN_FAILED', 'Session could not be renewed.');
    if (response.status === 404)
      throw new ServiceError('NOT_FOUND', 'Simply Veggie has no such record.');
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      const message = detail?.error || detail?.message || detail?.errors?.[0];
      throw new ServiceError(
        response.status === 422 ? 'REJECTED' : 'SITE_UNAVAILABLE',
        typeof message === 'string' ? message : `Simply Veggie returned HTTP ${response.status}.`,
      );
    }
    return response;
  }

  async json(method, path, options) {
    return (await this.request(method, path, options)).json();
  }

  async me() {
    let response = this.cookies.size ? await this.send('GET', '/me.json') : null;
    if (!response || response.status === 401) {
      await this.login();
      response = await this.send('GET', '/me.json');
    }
    if (!response.ok) throw new ServiceError('LOGIN_FAILED', 'Not signed in to Simply Veggie.');
    this.user = await response.json();
    return this.user;
  }

  /** The catalogue (price list) the signed-in account buys from. */
  async accountCatalog() {
    if (this.catalog) return this.catalog;
    const data = await this.json(
      'GET',
      `/catalog/structure.json?top_level_categories=true&merchant_id=${MERCHANT_ID}`,
    );
    const categories = (list = []) =>
      list.map((c) => ({ id: c.id, name: c.name, categories: categories(c.categories) }));
    this.catalog = { id: data.id, name: data.name, categories: categories(data.categories) };
    return this.catalog;
  }

  async search({ query, categoryId, onlyAvailable = true, limit = 20 }) {
    const catalog = await this.accountCatalog();
    const must = [
      { match_phrase: { merchant_id: MERCHANT_ID } },
      { match_phrase: { catalog_id: catalog.id } },
    ];
    if (onlyAvailable) must.push({ match_phrase: { is_available: true } });
    if (categoryId) must.push({ match_phrase: { category_id: categoryId } });
    const bool = { must };
    if (query) {
      bool.should = [
        { match_phrase_prefix: { name: query } },
        { match: { name: { query, fuzziness: 'AUTO' } } },
      ];
      bool.minimum_should_match = 1;
    }
    let response;
    try {
      response = await this.fetch(`${SEARCH}/${MERCHANT_ID}_category_items/_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          size: limit,
          query: { bool },
          ...(query ? {} : { sort: [{ listing_order: 'asc' }] }),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ServiceError(
        'SITE_UNAVAILABLE',
        'Product search did not respond; try again shortly.',
      );
    }
    if (!response.ok)
      throw new ServiceError('SITE_UNAVAILABLE', `Search failed (HTTP ${response.status}).`);
    const data = await response.json();
    return {
      catalog: { id: catalog.id, name: catalog.name },
      total: typeof data.hits?.total === 'object' ? data.hits.total.value : data.hits?.total,
      products: (data.hits?.hits || []).map((hit) => product(hit._source)),
    };
  }

  cart() {
    return this.json('GET', '/user/v0/cart.json');
  }

  async setCartQuantity({ itemId, quantity, variationId }) {
    const cart = await this.cart();
    const line = cartLines(cart).find(
      (l) => l.item_id === itemId && (!variationId || (l.variation_id || '') === variationId),
    );
    if (quantity === 0) {
      if (!line) return this.cart();
      await this.json('PUT', '/user/v0/cart/remove_item.json', {
        body: { cart: { line_item_id: line.id } },
      });
    } else if (line) {
      await this.json('PUT', '/user/v0/cart/update_item.json', {
        body: { cart: { line_item_id: line.id, quantity } },
      });
    } else {
      await this.json('PUT', '/user/v0/cart/add_item.json', {
        body: {
          cart: {
            item_id: itemId,
            variation_id: variationId || '',
            quantity,
            merchant_id: MERCHANT_ID,
          },
        },
      });
    }
    return this.cart();
  }

  orders({ page = 1 } = {}) {
    return this.json('GET', `/user/v0/orders.json?page_no=${page}`);
  }

  order(orderId) {
    return this.json('GET', `/user/v0/orders/${encodeURIComponent(orderId)}.json`);
  }

  async invoice(orderId) {
    const response = await this.request(
      'GET',
      `/user/v0/orders/${encodeURIComponent(orderId)}/download_invoice.json`,
      { accept: 'application/pdf, application/json' },
    );
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const data = await response.json();
      const url = data.url || data.invoice_url || data.data?.url;
      if (!url)
        throw new ServiceError(
          'INVOICE_UNAVAILABLE',
          'No invoice is available for this order yet.',
        );
      const file = await this.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!file.ok)
        throw new ServiceError('INVOICE_UNAVAILABLE', 'The invoice file could not be downloaded.');
      return Buffer.from(await file.arrayBuffer());
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

/** Line items of a cart response, whichever envelope the API uses. */
export function cartLines(cart) {
  const root = cart?.cart ?? cart?.data ?? cart ?? {};
  return root.line_items ?? root.items ?? [];
}
