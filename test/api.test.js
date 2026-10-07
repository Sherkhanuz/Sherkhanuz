import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, ensureDefaultUsers } from '../db.js';
import { createApp } from '../app.js';

let srv, base;
const jars = {};
async function call(who, method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'erp', cookie: jars[who] || '' },
    body: body ? JSON.stringify(body) : undefined });
  const c = r.headers.get('set-cookie'); if (c) jars[who] = c.split(';')[0];
  return { status: r.status, data: await r.json() };
}
before(async () => {
  const db = openDb(':memory:'); ensureDefaultUsers(db);
  srv = createApp(db).listen(0); await new Promise((r) => srv.on('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await call('a', 'POST', '/api/login', { username: 'admin', password: 'admin123' })).status, 200);
  assert.equal((await call('s', 'POST', '/api/login', { username: 'sotuvchi', password: 'sotuvchi123' })).status, 200);
});
after(() => srv.close());

test('rollar: sotuvchi admin API ga kira olmaydi, tannarxni ko\'rmaydi', async () => {
  assert.equal((await call('s', 'GET', '/api/admin/summary')).status, 403);
  assert.equal((await call('n', 'GET', '/api/products')).status, 401);
  const p = await call('a', 'POST', '/api/products', { name: 'Non', price: 4000, cost: 3000, stock: 10, min_stock: 5 });
  assert.equal(p.status, 200);
  const list = (await call('s', 'GET', '/api/products')).data;
  assert.equal(list[0].cost, undefined);
});

test('sotuv ombordan ayiradi, yetarli bo\'lmasa rad etadi', async () => {
  const id = (await call('a', 'GET', '/api/products')).data[0].id;
  assert.equal((await call('s', 'POST', '/api/sales', { items: [{ product_id: id, qty: 4 }] })).data.total, 16000);
  assert.equal((await call('s', 'GET', '/api/products')).data[0].stock, 6);
  assert.equal((await call('s', 'POST', '/api/sales', { items: [{ product_id: id, qty: 7 }] })).status, 409);
  assert.equal((await call('s', 'GET', '/api/products')).data[0].stock, 6);
});

test('kirim omborni oshiradi va xarid taklifi + buyurtma qabul qilish ishlaydi', async () => {
  const id = (await call('a', 'GET', '/api/products')).data[0].id;
  const sup = (await call('s', 'POST', '/api/suppliers', { name: 'Opt' })).data.id;
  assert.equal((await call('s', 'POST', '/api/receipts', { supplier_id: sup, items: [{ product_id: id, qty: 1, cost: 3100 }] })).status, 200);
  assert.equal((await call('a', 'GET', '/api/products')).data[0].stock, 7);
  await call('s', 'POST', '/api/sales', { items: [{ product_id: id, qty: 5 }] }); // 2 qoldi, min 5
  const offers = (await call('a', 'GET', '/api/admin/offers')).data;
  assert.equal(offers.length, 1);
  assert.equal(offers[0].supplier, 'Opt');
  assert.ok(offers[0].suggested_qty >= 8);
  const po = await call('a', 'POST', '/api/admin/purchase-orders', { supplier_id: sup, items: [{ product_id: id, qty: offers[0].suggested_qty, cost: offers[0].cost }] });
  assert.equal((await call('a', 'GET', '/api/admin/offers')).data.length, 0); // buyurtma qilingan — qayta taklif yo'q
  assert.equal((await call('a', 'POST', `/api/admin/purchase-orders/${po.data.id}/receive`)).status, 200);
  assert.equal((await call('a', 'POST', `/api/admin/purchase-orders/${po.data.id}/receive`)).status, 409);
  assert.equal((await call('a', 'GET', '/api/products')).data[0].stock, 2 + offers[0].suggested_qty);
});

test('tahlil: soatlik va kunlik', async () => {
  const h = (await call('a', 'GET', '/api/admin/hourly')).data;
  assert.equal(h.hours.length, 24);
  assert.equal(h.hours.reduce((a, x) => a + x.items, 0), 9);
  const d = (await call('a', 'GET', '/api/admin/daily')).data;
  assert.equal(d.days.length, 30);
  assert.equal(d.days.at(-1).revenue, 36000);
  assert.equal((await call('a', 'GET', '/api/admin/summary')).data.today.orders, 2);
});
