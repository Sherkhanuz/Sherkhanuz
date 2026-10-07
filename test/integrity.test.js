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
const rejects = async (sql, re = /o'chirib bo'lmaydi|o'zgartirilmaydi|o'zgartirilmaydi/) => {
  await assert.rejects(() => db.run(sql), (e) => re.test(e.message) || /integrity|violat/i.test(e.message));
};
let pid, supId, custId;

before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || null, dir: ':memory:' });
  if (process.env.TEST_DATABASE_URL) await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await ensureReady(db);
  srv = createApp(db).listen(0); await new Promise((r) => srv.on('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  await call('a', 'POST', '/api/login', { username: 'admin', password: 'admin123' });
  await call('s', 'POST', '/api/login', { username: 'sotuvchi', password: 'sotuvchi123' });
  await call('a', 'POST', '/api/admin/cash-operations', { kind: 'owner_deposit', amount: 1000000 }); // yetkazuvchisiz kirim kassadan to'lanadi
  pid = (await call('a', 'POST', '/api/products', { name: 'Non', sku: '1', price: 4000, cost: 3000, stock: 10, min_stock: 2 })).data.id;
  supId = (await call('a', 'POST', '/api/suppliers', { name: 'Opt' })).data.id;
  custId = (await call('s', 'POST', '/api/customers', { name: 'Karim' })).data.id;
});
after(async () => { srv.close(); await db.close(); });

test('DB darajasida hech narsa o\'chirilmaydi va hujjat o\'zgarmaydi', async () => {
  await call('s', 'POST', '/api/sales', { items: [{ product_id: pid, qty: 1 }] });
  for (const t of ['users', 'products', 'suppliers', 'customers', 'sales', 'sale_items', 'receipts', 'stock_moves', 'sessions', 'login_attempts', 'change_log', 'purchase_orders'])
    await rejects(`DELETE FROM ${t}`);
  await rejects('TRUNCATE sales CASCADE');
  await rejects('UPDATE sales SET total = 1');
  await rejects('UPDATE sale_items SET qty = 99');
  await rejects('UPDATE stock_moves SET qty = 0');
  await rejects('UPDATE change_log SET new_value = \'x\'');
  assert.ok((await db.one('SELECT COUNT(*)::int c FROM sales')).c >= 1);
});

test('mahsulot: noaktiv qilish qoidalari va ta\'siri', async () => {
  // qoldiq bor — noaktiv qilib bo'lmaydi
  assert.equal((await call('a', 'POST', `/api/products/${pid}/status`, { active: false })).status, 409);
  const p2 = (await call('a', 'POST', '/api/products', { name: 'Bo\'sh', sku: '2', price: 1000, stock: 0 })).data.id;
  assert.equal((await call('a', 'POST', `/api/products/${p2}/status`, { active: false })).status, 200);
  // sotuvchi noaktivni ko'rmaydi, sota olmaydi; admin filtr bilan ko'radi
  assert.ok(!(await call('s', 'GET', '/api/products?status=all')).data.some((p) => p.id === p2));
  assert.equal((await call('s', 'POST', '/api/sales', { items: [{ product_id: p2, qty: 1 }] })).status, 400);
  assert.deepEqual((await call('a', 'GET', '/api/products?status=inactive')).data.map((p) => p.id), [p2]);
  assert.ok((await call('a', 'GET', '/api/products?status=all')).data.length >= 2);
  // qayta faollashtirish
  assert.equal((await call('a', 'POST', `/api/products/${p2}/status`, { active: true })).status, 200);
  assert.equal((await call('a', 'POST', `/api/products/${p2}/status`, { active: 'yoq' })).status, 400);
  // DELETE endpointi mavjud emas
  assert.equal((await call('a', 'DELETE', `/api/products/${p2}`)).status, 404);
});

test('mijoz va yetkazuvchi: noaktiv holat', async () => {
  await call('s', 'POST', '/api/sales', { items: [{ product_id: pid, qty: 1 }], customer_id: custId, paid: 0 });
  assert.equal((await call('a', 'POST', `/api/customers/${custId}/status`, { active: false })).status, 409); // qarzi bor
  await call('s', 'POST', `/api/customers/${custId}/payments`, { amount: 4000 });
  assert.equal((await call('a', 'POST', `/api/customers/${custId}/status`, { active: false })).status, 200);
  assert.equal((await call('s', 'POST', '/api/sales', { items: [{ product_id: pid, qty: 1 }], customer_id: custId })).status, 400);
  assert.equal((await call('s', 'GET', '/api/customers')).data.some((c) => c.id === custId), false);
  assert.equal((await call('a', 'GET', '/api/customers?status=all')).data.some((c) => c.id === custId), true);
  assert.equal((await call('a', 'POST', `/api/suppliers/${supId}/status`, { active: false })).status, 200);
  assert.equal((await call('s', 'POST', '/api/receipts', { supplier_id: supId, items: [{ product_id: pid, qty: 1, cost: 3000 }] })).status, 400);
  assert.equal((await call('s', 'POST', '/api/suppliers/1/status', { active: true })).status, 403); // sotuvchi o'zgartira olmaydi
  await call('a', 'POST', `/api/suppliers/${supId}/status`, { active: true });
});

test('kirimni storno qilish: asl hujjat o\'zgarmaydi, takroriy storno rad etiladi', async () => {
  const before = (await call('a', 'GET', '/api/products')).data.find((p) => p.id === pid).stock;
  const r = await call('s', 'POST', '/api/receipts', { supplier_id: supId, items: [{ product_id: pid, qty: 5, cost: 3100 }] });
  assert.equal((await call('s', 'POST', `/api/admin/receipts/${r.data.id}/reverse`)).status, 403); // faqat admin
  const rev = await call('a', 'POST', `/api/admin/receipts/${r.data.id}/reverse`);
  assert.equal(rev.status, 200);
  assert.equal(rev.data.total, -15500);
  assert.equal((await call('a', 'GET', '/api/products')).data.find((p) => p.id === pid).stock, before);
  assert.equal((await call('a', 'POST', `/api/admin/receipts/${r.data.id}/reverse`)).status, 409);
  // tovar sotilgan bo'lsa storno mumkin emas
  const r2 = await call('s', 'POST', '/api/receipts', { items: [{ product_id: pid, qty: 3, cost: 3000 }] });
  const stock = (await call('a', 'GET', '/api/products')).data.find((p) => p.id === pid).stock;
  await call('s', 'POST', '/api/sales', { items: [{ product_id: pid, qty: stock }] });
  assert.equal((await call('a', 'POST', `/api/admin/receipts/${r2.data.id}/reverse`)).status, 409);
  assert.equal((await db.one('SELECT total FROM receipts WHERE id=?', [r.data.id])).total, 15500); // asl hujjat o'zgarmagan
});

test('o\'zgarishlar tarixi: kim, qaysi maydon, eski → yangi', async () => {
  await call('a', 'PUT', `/api/products/${pid}`, { name: 'Non', sku: '1', price: 4500, cost: 3000, min_stock: 2 });
  const log = (await call('a', 'GET', `/api/admin/change-log?table=products&record_id=${pid}`)).data;
  const price = log.find((l) => l.field === 'price');
  assert.deepEqual([price.old_value, price.new_value, price.user, price.label], ['4000', '4500', 'Administrator', 'Non']);
  assert.ok(!log.some((l) => l.field === 'stock')); // qoldiq tarixi stock_moves da
  assert.equal((await call('s', 'GET', '/api/admin/change-log')).status, 403);
  // parol xeshi tarixda ko'rinmaydi
  await call('a', 'PUT', '/api/admin/users/2', { password: 'yangi-parol-1' });
  const pw = (await call('a', 'GET', '/api/admin/change-log?table=users')).data.find((l) => l.field === 'password_hash');
  assert.deepEqual([pw.old_value, pw.new_value], ['***', '***']);
});

test('foydalanuvchi: noaktiv qilish sessiyani bekor qiladi, oxirgi admin himoyalangan, logout o\'chirmaydi', async () => {
  const sellers = (await call('a', 'GET', '/api/admin/users')).data;
  const sid = sellers.find((u) => u.role === 'seller').id, aid = sellers.find((u) => u.role === 'admin').id;
  assert.equal((await call('a', 'PUT', `/api/admin/users/${aid}`, { active: false })).status, 400); // o'zini yoki oxirgi adminni
  assert.equal((await call('a', 'PUT', `/api/admin/users/${sid}`, { active: false })).status, 200);
  assert.equal((await call('s', 'GET', '/api/products')).status, 401); // sessiya bekor
  assert.equal((await call('x', 'POST', '/api/login', { username: 'sotuvchi', password: 'yangi-parol-1' })).status, 401); // kirib bo'lmaydi
  await call('a', 'PUT', `/api/admin/users/${sid}`, { active: true });
  assert.equal((await call('x', 'POST', '/api/login', { username: 'sotuvchi', password: 'yangi-parol-1' })).status, 200);
  const n = (await db.one('SELECT COUNT(*)::int c FROM sessions')).c;
  await call('x', 'POST', '/api/logout');
  assert.equal((await db.one('SELECT COUNT(*)::int c FROM sessions')).c, n); // sessiya o'chirilmaydi, bekor qilinadi
  assert.equal((await call('x', 'GET', '/api/me')).status, 401);
});
