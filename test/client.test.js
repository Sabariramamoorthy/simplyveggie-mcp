import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimplyVeggieClient, product, cartLines, cartView } from '../src/client.js';

class MemoryStore {
  data = {};
  async read(name, fallback) {
    return this.data[name] ?? fallback;
  }
  async write(name, value) {
    this.data[name] = value;
  }
}

const json = (status, body, cookies = []) =>
  new Response(JSON.stringify(body), {
    status,
    headers: [['content-type', 'application/json'], ...cookies.map((c) => ['set-cookie', c])],
  });

function fakeSite({ cart = { line_items: [] } } = {}) {
  const calls = [];
  let session = null;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body, cookie: init.headers?.Cookie });
    if (path === '/users/sign_in.json') {
      if (body.user.password !== 'right') return json(401, { error: 'Invalid login or password.' });
      session = 'abc';
      return json(200, { name: 'Kitchen' }, ['_session=abc; path=/; HttpOnly']);
    }
    if (init.headers?.Cookie !== `_session=${session}`)
      return json(401, { error: 'unauthenticated' });
    if (path === '/me.json') return json(200, { name: 'Kitchen', catalog_type: 'common' });
    if (path === '/catalog/structure.json')
      return new URL(url).searchParams.get('filter') === 'common'
        ? json(200, { id: 'BASE', name: 'Base Catalog', categories: [{ id: 'V', name: 'Vegetables', categories: [] }] })
        : json(200, { id: 'MENU', name: 'Menu', categories: [] });
    if (path === '/user/v0/cart.json') return json(200, cart);
    if (path === '/user/v0/cart/add_item.json') {
      cart.line_items.push({ id: 'L1', item_id: body.cart.item_id, quantity: body.cart.quantity });
      return json(200, cart);
    }
    if (path === '/user/v0/cart/update_item.json') {
      cart.line_items.find((l) => l.id === body.cart.line_item_id).quantity = body.cart.quantity;
      return json(200, cart);
    }
    if (path === '/user/v0/cart/remove_item.json') {
      cart.line_items = cart.line_items.filter((l) => l.id !== body.cart.line_item_id);
      return json(200, cart);
    }
    return json(404, {});
  };
  return { calls, fetchImpl, expire: () => (session = 'rotated') };
}

test('logs in on first use, persists the cookie and reuses it', async () => {
  const site = fakeSite(),
    store = new MemoryStore();
  const client = new SimplyVeggieClient({
    phone: '9000000000',
    password: 'right',
    store,
    fetchImpl: site.fetchImpl,
  });
  await client.init();
  await client.cart();
  assert.deepEqual(store.data.session, { _session: 'abc' });
  await client.cart();
  assert.equal(site.calls.filter((c) => c.path === '/users/sign_in.json').length, 1);
});

test('renews an expired session once and retries the request', async () => {
  const site = fakeSite();
  const client = new SimplyVeggieClient({
    phone: '9000000000',
    password: 'right',
    store: new MemoryStore(),
    fetchImpl: site.fetchImpl,
  });
  await client.cart();
  site.expire();
  await client.cart();
  assert.equal(site.calls.filter((c) => c.path === '/users/sign_in.json').length, 2);
});

test('reports wrong credentials without retrying in a loop', async () => {
  const site = fakeSite();
  const client = new SimplyVeggieClient({
    phone: '9000000000',
    password: 'wrong',
    store: new MemoryStore(),
    fetchImpl: site.fetchImpl,
  });
  await assert.rejects(client.cart(), { code: 'LOGIN_FAILED' });
  assert.equal(site.calls.filter((c) => c.path === '/users/sign_in.json').length, 1);
});

test('reports missing credentials before calling the site', async () => {
  const site = fakeSite();
  const client = new SimplyVeggieClient({ store: new MemoryStore(), fetchImpl: site.fetchImpl });
  await assert.rejects(client.login(), { code: 'CREDENTIALS_MISSING' });
  assert.equal(site.calls.length, 0);
});

test('set quantity adds, updates, then removes the same line', async () => {
  const site = fakeSite();
  const client = new SimplyVeggieClient({
    phone: '9000000000',
    password: 'right',
    store: new MemoryStore(),
    fetchImpl: site.fetchImpl,
  });
  assert.equal(
    cartLines(await client.setCartQuantity({ itemId: 'P1', quantity: 2 }))[0].quantity,
    2,
  );
  assert.equal(
    cartLines(await client.setCartQuantity({ itemId: 'P1', quantity: 5 }))[0].quantity,
    5,
  );
  assert.equal(cartLines(await client.setCartQuantity({ itemId: 'P1', quantity: 0 })).length, 0);
  const paths = site.calls.map((c) => c.path).filter((p) => p.includes('/cart/'));
  assert.deepEqual(paths, [
    '/user/v0/cart/add_item.json',
    '/user/v0/cart/update_item.json',
    '/user/v0/cart/remove_item.json',
  ]);
});

test("selects the account's catalogue by its catalog_type", async () => {
  const site = fakeSite();
  const client = new SimplyVeggieClient({
    phone: '9000000000',
    password: 'right',
    store: new MemoryStore(),
    fetchImpl: site.fetchImpl,
  });
  const catalog = await client.accountCatalog();
  assert.equal(catalog.id, 'BASE');
  assert.equal(catalog.categories[0].name, 'Vegetables');
});

test('converts cart amounts from paise to rupees', () => {
  const view = cartView({
    item_count: 1,
    sub_total_price: 6600,
    total_price: 6600,
    items: [{ id: 'L1', item_id: 'P1', name: 'Tomato', quantity: 2, rate: 3300, total_price: 6600 }],
  });
  assert.equal(view.total, 66);
  assert.equal(view.items[0].rate, 33);
  assert.equal(view.items[0].total, 66);
});

test('normalizes a catalogue search hit', () => {
  const p = product({
    id: 'X',
    name: 'Cherry Tomato',
    category_id: 'C',
    is_available: true,
    sold_out: false,
    stock_count: 10,
    price: { total_price: 33.37, base_price: 33.37, tax: 0 },
    other_data: { display_quantity: '0.25', display_name: 'Kg', on_offer: '0', old_price: null },
    variations: [],
  });
  assert.equal(p.price, 33.37);
  assert.equal(p.unit, '0.25 Kg');
  assert.equal(p.available, true);
  assert.equal(p.onOffer, false);
});
