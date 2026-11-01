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

/** Kilograms in one pack, when the pack is sold by weight ("1 Kg", "0.25 Kg (240-260g)", "500 gm"). */
export function packKg(displayQuantity, displayName) {
  const size = number(displayQuantity);
  if (!size || !displayName) return null;
  if (/^kgs?\b/i.test(displayName.trim())) return size;
  if (/^(g|gm|gms|grams?)\b/i.test(displayName.trim())) return size / 1000;
  return null;
}

export const formatKg = (kg) => (kg >= 1 ? `${+kg.toFixed(3)} kg` : `${Math.round(kg * 1000)} g`);

export function product(source) {
  const other = source.other_data || {};
  const unit = [other.display_quantity, other.display_name].filter(Boolean).join(' ') || null;
  const price = number(source.price?.total_price);
  return {
    id: source.id,
    name: source.name,
    categoryId: source.category_id,
    price,
    priceLabel: price === null ? null : `₹${price} per ${unit || 'unit'}`,
    basePrice: number(source.price?.base_price),
    tax: number(source.price?.tax),
    unit,
    packKg: packKg(other.display_quantity, other.display_name),
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

  /**
   * The catalogue (price list) the signed-in account buys from. The site selects it with the
   * account's `catalog_type` as the structure filter; unfiltered, it returns an empty "Menu".
   */
  async accountCatalog() {
    if (this.catalog) return this.catalog;
    const user = this.user?.catalog_type !== undefined ? this.user : await this.me();
    const filter = user.catalog_type ? `&filter=${encodeURIComponent(user.catalog_type)}` : '';
    const data = await this.json(
      'GET',
      `/catalog/structure.json?top_level_categories=true&merchant_id=${MERCHANT_ID}${filter}`,
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

  /** Products of the account's catalogue by id (unavailable ones included), as a Map. */
  async productsByIds(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const catalog = await this.accountCatalog();
    let response;
    try {
      response = await this.fetch(`${SEARCH}/${MERCHANT_ID}_category_items/_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          size: unique.length,
          query: {
            bool: {
              must: [{ terms: { id: unique } }, { match_phrase: { catalog_id: catalog.id } }],
            },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ServiceError(
        'SITE_UNAVAILABLE',
        'Product lookup did not respond; try again shortly.',
      );
    }
    if (!response.ok)
      throw new ServiceError(
        'SITE_UNAVAILABLE',
        `Product lookup failed (HTTP ${response.status}).`,
      );
    const data = await response.json();
    return new Map((data.hits?.hits || []).map((hit) => [hit._source.id, product(hit._source)]));
  }

  cart() {
    return this.json('GET', '/user/v0/cart.json');
  }

  /** Cart in rupees, each line annotated with its pack size and total weight. */
  async cartDetails() {
    const cart = await this.cart();
    const view = cartView(cart);
    const products = await this.productsByIds(view.items.map((line) => line.itemId));
    view.items = view.items.map((line) => withPack(line, products.get(line.itemId)));
    return view;
  }

  async changeLine(line, { itemId, quantity, variationId }) {
    if (quantity === 0) {
      if (!line) return;
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
  }

  async setCartQuantity({ itemId, quantity, variationId }) {
    const cart = await this.cart();
    await this.changeLine(findLine(cart, itemId, variationId), { itemId, quantity, variationId });
    return this.cart();
  }

  /**
   * Adds (or sets) several products in one call. Each request gives packs (`quantity`) or a
   * weight (`weightKg`, converted to whole packs). Every product is checked against the
   * account's catalogue first; nothing is changed for a request that fails validation.
   */
  async addItems(requests, { mode = 'add' } = {}) {
    const products = await this.productsByIds(requests.map((r) => r.itemId));
    const planned = new Map(),
      results = [];
    for (const request of requests) {
      const item = products.get(request.itemId);
      const fail = (message) =>
        results.push({
          itemId: request.itemId,
          name: item?.name ?? null,
          status: 'FAILED',
          message,
        });
      if (!item) {
        fail('Not in this account’s catalogue; search again.');
        continue;
      }
      if (!item.available) {
        fail('Currently unavailable.');
        continue;
      }
      const packs = packsFor(request, item);
      if (packs.error) {
        fail(packs.error);
        continue;
      }
      const key = `${item.id}|${request.variationId || ''}`;
      planned.set(key, {
        item,
        variationId: request.variationId,
        packs: (planned.get(key)?.packs || 0) + packs.value,
      });
    }
    const cart = await this.cart();
    for (const { item, variationId, packs } of planned.values()) {
      const line = findLine(cart, item.id, variationId);
      const previous = number(line?.quantity) || 0;
      const target = mode === 'set' ? packs : previous + packs;
      try {
        await this.changeLine(line, { itemId: item.id, quantity: target, variationId });
        results.push({
          itemId: item.id,
          name: item.name,
          status: line ? 'UPDATED' : 'ADDED',
          previous,
          target,
        });
      } catch (error) {
        results.push({
          itemId: item.id,
          name: item.name,
          status: 'FAILED',
          message: error.message,
        });
      }
    }
    const view = await this.cartDetails();
    for (const result of results) {
      if (result.status === 'FAILED') continue;
      const line = view.items.find((l) => l.itemId === result.itemId);
      result.verified = Number(line?.quantity) === result.target;
      result.inCart = line
        ? { packs: line.quantity, amount: line.amount, total: line.total }
        : null;
    }
    return { results, cart: view };
  }

  async orders({ page = 1 } = {}) {
    const data = await this.json('GET', `/user/v0/orders.json?page_no=${page}`);
    const list = Array.isArray(data) ? data : (data.orders ?? []);
    return { totalCount: number(data.total_count), orders: list.map(orderSummary) };
  }

  async order(orderId) {
    const data = await this.json('GET', `/user/v0/orders/${encodeURIComponent(orderId)}.json`);
    return orderDetail(data.order ?? data);
  }

  /** Accepts the internal id or the order number shown to customers (e.g. 202610260092). */
  async resolveOrderId(reference) {
    const ref = String(reference).trim().replace(/^#/, '');
    if (/^[a-f0-9]{24}$/i.test(ref)) return ref;
    for (let page = 1; page <= 20; page++) {
      const { orders } = await this.orders({ page });
      const match = orders.find((o) => o.number === ref);
      if (match) return match.id;
      if (!orders.length) break;
    }
    throw new ServiceError('NOT_FOUND', `No order numbered ${ref} was found in this account.`);
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

function findLine(cart, itemId, variationId) {
  return cartLines(cart).find(
    (l) => l.item_id === itemId && (!variationId || (l.variation_id || '') === variationId),
  );
}

/** Whole packs for a request given in packs or kilograms. */
export function packsFor({ quantity, weightKg }, item) {
  if (weightKg !== undefined) {
    if (!item.packKg)
      return {
        error: `Sold per ${item.unit || 'unit'}, not by weight; give quantity in ${item.unit || 'units'}.`,
      };
    const packs = weightKg / item.packKg;
    const whole = Math.round(packs);
    if (whole < 1 || Math.abs(packs - whole) > 1e-6) {
      const below = Math.max(1, Math.floor(packs)),
        above = Math.ceil(packs);
      return {
        error: `Sold in ${formatKg(item.packKg)} packs, so ${formatKg(weightKg)} is not a whole number of packs. Use ${formatKg(below * item.packKg)} (${below} packs) or ${formatKg(above * item.packKg)} (${above} packs).`,
      };
    }
    return { value: whole };
  }
  if (!Number.isInteger(quantity) || quantity < 1)
    return { error: 'quantity must be a whole number of packs (1 or more).' };
  return { value: quantity };
}

function withPack(line, item) {
  if (!item) return { ...line, unit: null, amount: null };
  const kg = item.packKg && line.quantity ? item.packKg * line.quantity : null;
  return {
    ...line,
    name: line.name ?? item.name,
    unit: item.unit,
    amount: kg ? formatKg(kg) : `${line.quantity} × ${item.unit || 'unit'}`,
  };
}

/** Line items of a cart response, whichever envelope the API uses. */
export function cartLines(cart) {
  const root = cart?.cart ?? cart?.data ?? cart ?? {};
  return root.line_items ?? root.items ?? [];
}

// The cart API reports money in paise; catalogue and order APIs use rupees.
const rupees = (paise) => (number(paise) === null ? null : number(paise) / 100);

export function cartView(cart) {
  const root = cart?.cart ?? cart?.data ?? cart ?? {};
  return {
    currency: 'INR',
    itemCount: number(root.item_count) ?? cartLines(cart).length,
    subTotal: rupees(root.sub_total_price),
    charges: rupees(root.total_charges),
    taxes: rupees(root.total_taxes),
    discounts: rupees(root.total_discounts),
    total: rupees(root.total_price),
    items: cartLines(cart).map((line) => ({
      lineId: line.id,
      itemId: line.item_id,
      variationId: line.variation_id || null,
      name: line.name ?? line.item_name ?? null,
      quantity: number(line.quantity),
      rate: rupees(line.rate ?? line.price ?? line.unit_price),
      total: rupees(line.total_price ?? line.total_amount),
    })),
    invalidItems: (root.invalid_line_items || []).map((line) => ({
      itemId: line.item_id,
      name: line.name ?? null,
      reason: line.reason ?? line.message ?? null,
    })),
  };
}

export function orderSummary(order) {
  return {
    id: order.id,
    number: order.friendly_id,
    status: order.status,
    deliveryStatus: order.delivery_status || null,
    paymentStatus: order.payment_status || null,
    paymentMode: order.payment_mode || order.payment_type || null,
    createdAt: order.created_at,
    acceptedAt: order.accepted_at || null,
    dispatchedAt: order.dispatched_at || null,
    deliverySlot:
      order.time_slot_value ||
      (order.delivery_slot_start_time
        ? `${order.delivery_slot_start_time} – ${order.delivery_slot_end_time}`
        : null),
    deliveredAt: order.delivered_at || null,
    itemCount: number(order.no_of_items),
    totalAmount: number(order.total_amount),
    balanceAmount: number(order.balance_amount),
    invoiceNumber: order.invoice_number || null,
  };
}

export function orderDetail(order) {
  return {
    ...orderSummary(order),
    amounts: {
      gross: number(order.gross_amount),
      bill: number(order.bill_amount),
      tax: number(order.tax_amount),
      discount: number(order.discount),
      deliveryCharge: number(order.delivery_charge),
      packingCharge: number(order.packing_charge),
      returned: number(order.returned_amount),
      undelivered: number(order.undelivered_amount),
      total: number(order.total_amount),
    },
    instructions: order.instructions || null,
    items: (order.items || []).map((item) => ({
      itemId: item.item_id,
      name: item.name,
      quantity: number(item.quantity),
      deliveredQuantity: number(item.delivered_quantity),
      returnedQuantity: number(item.returned_quantity),
      rate: number(item.rate),
      total: number(item.total_amount ?? item.total_price),
      tax: number(item.total_tax),
      discount: number(item.discount_amount),
      undeliveredAmount: number(item.undelivered_amount),
      returnedAmount: number(item.returned_amount),
      status: item.status || null,
    })),
  };
}
