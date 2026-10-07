import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, ensureReady } from '../db.js';
import { createApp } from '../app.js';

let srv, base, db;
const jars = {};
async function call(who, method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'erp', cookie: jars[who] || '' },
    body: body ? JSON.stringify(body) : undefined });
  const c = r.headers.get('set-cookie'); if (c) jars[who] = c.split(';')[0];
  return { status: r.status, data: await r.json() };
}
const products = async (who = 'a') => (await call(who, 'GET', '/api/products')).data;

before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || null, dir: ':memory:' });
  if (process.env.TEST_DATABASE_URL) await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await ensureReady(db);
  srv = createApp(db).listen(0); await new Promise((r) => srv.on('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await call('a', 'POST', '/api/login', { username: 'admin', password: 'admin123' })).status, 200);
  assert.equal((await call('s', 'POST', '/api/login', { username: 'sotuvchi', password: 'sotuvchi123' })).status, 200);
});
after(async () => { srv.close(); await db.close(); });

test('rollar: sotuvchi admin API ga kira olmaydi, tannarxni ko\'rmaydi', async () => {
  assert.equal((await call('s', 'GET', '/api/admin/summary')).status, 403);
  assert.equal((await call('n', 'GET', '/api/products')).status, 401);
  const p = await call('a', 'POST', '/api/products', { name: 'Non', sku: '111', price: 4000, cost: 3000, stock: 10, min_stock: 5 });
  assert.equal(p.status, 200);
  assert.equal((await call('a', 'POST', '/api/products', { name: 'Boshqa', sku: '111', price: 1 })).status, 400); // SKU takror
  assert.equal((await products('s'))[0].cost, undefined);
});

test('sotuv ombordan ayiradi, yetarli bo\'lmasa rad etadi', async () => {
  const id = (await products())[0].id;
  assert.equal((await call('s', 'POST', '/api/sales', { items: [{ product_id: id, qty: 4 }] })).data.total, 16000);
  assert.equal((await products('s'))[0].stock, 6);
  assert.equal((await call('s', 'POST', '/api/sales', { items: [{ product_id: id, qty: 7 }] })).status, 409);
  assert.equal((await products('s'))[0].stock, 6);
});

test('kirim omborni oshiradi; xarid taklifi, buyurtma va qabul qilish', async () => {
  const id = (await products())[0].id;
  const sup = (await call('s', 'POST', '/api/suppliers', { name: 'Opt' })).data.id;
  assert.equal((await call('s', 'POST', '/api/receipts', { supplier_id: sup, items: [{ product_id: id, qty: 1, cost: 3100 }] })).status, 200);
  assert.equal((await products())[0].stock, 7);
  await call('s', 'POST', '/api/sales', { items: [{ product_id: id, qty: 5 }] }); // 2 qoldi, min 5
  const offers = (await call('a', 'GET', '/api/admin/offers')).data;
  assert.equal(offers.length, 1);
  assert.equal(offers[0].supplier, 'Opt');
  assert.ok(offers[0].suggested_qty >= 8);
  const po = await call('a', 'POST', '/api/admin/purchase-orders', { supplier_id: sup, items: [{ product_id: id, qty: offers[0].suggested_qty, cost: offers[0].cost }] });
  assert.equal((await call('a', 'GET', '/api/admin/offers')).data.length, 0); // qayta taklif yo'q
  assert.equal((await call('a', 'GET', '/api/admin/purchase-orders')).data[0].items.length, 1);
  assert.equal((await call('a', 'POST', `/api/admin/purchase-orders/${po.data.id}/receive`)).status, 200);
  assert.equal((await call('a', 'POST', `/api/admin/purchase-orders/${po.data.id}/receive`)).status, 409);
  assert.equal((await products())[0].stock, 2 + offers[0].suggested_qty);
});

test('chegirma, nasiya va qaytarish', async () => {
  const id = (await products())[0].id;
  const before = (await products())[0].stock;
  const cust = (await call('s', 'POST', '/api/customers', { name: 'Karim' })).data.id;
  // 3 dona = 12000, 10% chegirma = 10800, 800 to'langan -> 10000 nasiya
  assert.equal((await call('s', 'POST', '/api/sales', { items: [{ product_id: id, qty: 3 }], discount_type: 'percent', discount: 10, paid: 800 })).status, 400); // mijoz kerak
  const sale = (await call('s', 'POST', '/api/sales', { items: [{ product_id: id, qty: 3 }], discount_type: 'percent', discount: 10, paid: 800, customer_id: cust })).data;
  assert.deepEqual([sale.subtotal, sale.discount, sale.total, sale.debt], [12000, 1200, 10800, 10000]);
  assert.equal((await call('s', 'GET', '/api/customers')).data[0].balance, 10000);
  // qaytarish: 1 dona = 3600, qarzga
  const detail = (await call('s', 'GET', `/api/sales/${sale.id}`)).data;
  assert.equal(detail.items[0].returnable, 3);
  const ret = await call('s', 'POST', '/api/returns', { sale_id: sale.id, refund: 'debt', items: [{ sale_item_id: detail.items[0].id, qty: 1 }] });
  assert.deepEqual([ret.data.total, ret.data.to_debt, ret.data.cash_refund], [3600, 3600, 0]);
  assert.equal((await call('s', 'GET', '/api/customers')).data[0].balance, 6400);
  assert.equal((await products())[0].stock, before - 2);
  assert.equal((await call('s', 'GET', `/api/sales/${sale.id}`)).data.items[0].returnable, 1 + 1); // 3 - 1 qaytarilgan
  // ortiqcha qaytarish rad etiladi
  assert.equal((await call('s', 'POST', '/api/returns', { sale_id: sale.id, items: [{ sale_item_id: detail.items[0].id, qty: 3 }] })).status, 409);
  // qarz to'lash: oshib ketsa rad
  assert.equal((await call('s', 'POST', `/api/customers/${cust}/payments`, { amount: 7000 })).status, 409);
  assert.equal((await call('s', 'POST', `/api/customers/${cust}/payments`, { amount: 6400 })).data.balance, 0);
});

test('tahlil: soatlik, kunlik; qaytarish tushumdan ayriladi', async () => {
  const hr = await call('a', 'GET', '/api/admin/hourly')
  const h = hr.data;
  assert.equal(h.hours.length, 24);
  const d = (await call('a', 'GET', '/api/admin/daily')).data;
  assert.equal(d.days.length, 30);
  // 16000 + 5*4000 + 10800 - 3600 (qaytarish)
  assert.equal(d.days.at(-1).revenue, 16000 + 20000 + 10800 - 3600);
  const s = (await call('a', 'GET', '/api/admin/summary')).data;
  assert.equal(s.today.orders, 3);
  assert.equal(s.debt.total, 0);
});
