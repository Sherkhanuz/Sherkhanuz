import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, ensureReady } from '../db.js';
import { createApp } from '../app.js';

let srv, base, db, uid, pid, sup, cust;
const jars = {};
async function call(who, method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'erp', cookie: jars[who] || '' },
    body: body ? JSON.stringify(body) : undefined });
  const c = r.headers.get('set-cookie'); if (c) jars[who] = c.split(';')[0];
  return { status: r.status, data: await r.json() };
}
const cash = async (m = 'cash') => (await db.one('SELECT balance FROM cash_accounts WHERE method=?', [m])).balance;
const supBal = async () => (await call('s', 'GET', `/api/suppliers/${sup}/account`)).data;
const violates = (fn, re) => assert.rejects(() => db.tx(fn), (e) => re.test(e.message), `kutilgan xato: ${re}`);

before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || null, dir: ':memory:' });
  if (process.env.TEST_DATABASE_URL) await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await ensureReady(db);
  srv = createApp(db).listen(0); await new Promise((r) => srv.on('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  await call('a', 'POST', '/api/login', { username: 'admin', password: 'admin123' });
  await call('s', 'POST', '/api/login', { username: 'sotuvchi', password: 'sotuvchi123' });
  uid = (await db.one("SELECT id FROM users WHERE username='admin'")).id;
  pid = (await call('a', 'POST', '/api/products', { name: 'Non', sku: '1', price: 4000, cost: 3000, stock: 10, min_stock: 2 })).data.id;
  sup = (await call('a', 'POST', '/api/suppliers', { name: 'Opt' })).data.id;
  cust = (await call('s', 'POST', '/api/customers', { name: 'Karim' })).data.id;
});
after(async () => { srv.close(); await db.close(); });

test('kassa: pul bo\'lmasa chiqim mumkin emas; egasi pul kiritsa kassa ko\'payadi', async () => {
  assert.equal(await cash(), 0);
  const r = await call('s', 'POST', '/api/supplier-payments', { supplier_id: sup, kind: 'payment', amount: 1000 });
  assert.equal(r.status, 409); assert.match(r.data.error, /Kassada mablag/);
  assert.equal((await call('s', 'POST', '/api/admin/cash-operations', { kind: 'owner_deposit', amount: 5 })).status, 403); // faqat admin
  assert.equal((await call('a', 'POST', '/api/admin/cash-operations', { kind: 'owner_deposit', amount: 2000000 })).status, 200);
  assert.equal(await cash(), 2000000);
  await assert.rejects(() => db.run("UPDATE cash_accounts SET balance = 99 WHERE method='cash'"), /to'g'ridan-to'g'ri/);
});

test('yetkazuvchiga avans -> tovar qabul qilish avansdan ayriladi -> qolgan pulni qaytarib olish kassani oshiradi', async () => {
  // 1) pul berish: kassa kamayadi, yetkazuvchida avans paydo bo'ladi
  const pay = await call('s', 'POST', '/api/supplier-payments', { supplier_id: sup, kind: 'payment', amount: 1000000, note: 'avans' });
  assert.equal(pay.status, 200);
  assert.equal(await cash(), 1000000);
  let acc = (await supBal()); assert.deepEqual([acc.balance, acc.advance, acc.payable], [-1000000, 1000000, 0]);
  // 2) tovar qabul qilish (6 ta x 3 100 = 18 600... 300 dona): avansdan ayriladi, kassa o'zgarmaydi
  const rec = await call('s', 'POST', '/api/receipts', { supplier_id: sup, items: [{ product_id: pid, qty: 200, cost: 3100 }] }); // 620 000
  assert.equal(rec.status, 200); assert.equal(rec.data.total, 620000);
  assert.equal(await cash(), 1000000);
  acc = await supBal(); assert.deepEqual([acc.balance, acc.advance], [-380000, 380000]);
  // 3) ortiqcha avansni qaytarib olish mumkin emas
  const bad = await call('s', 'POST', '/api/supplier-payments', { supplier_id: sup, kind: 'refund', amount: 380001 });
  assert.equal(bad.status, 409); assert.match(bad.data.error, /avans yetarli emas/);
  // 4) qolgan avansni qaytarib olish: kassa ko'payadi
  const back = await call('s', 'POST', '/api/supplier-payments', { supplier_id: sup, kind: 'refund', amount: 380000, method: 'cash' });
  assert.equal(back.status, 200); assert.equal(back.data.balance, 0);
  assert.equal(await cash(), 1380000);
  acc = await supBal(); assert.deepEqual([acc.balance, acc.advance, acc.payable], [0, 0, 0]);
  assert.deepEqual(acc.entries.map((e) => e.kind), ['refund', 'receipt', 'payment']);
  // 5) avansdan ortiq kirim: qarz (payable) paydo bo'ladi, keyin to'lash mumkin
  await call('s', 'POST', '/api/receipts', { supplier_id: sup, items: [{ product_id: pid, qty: 100, cost: 3000 }] }); // 300 000
  acc = await supBal(); assert.deepEqual([acc.balance, acc.payable], [300000, 300000]);
  assert.equal((await call('s', 'POST', '/api/supplier-payments', { supplier_id: sup, kind: 'payment', amount: 300000 })).data.balance, 0);
  assert.equal(await cash(), 1080000);
  // noaktiv yetkazuvchi bilan pul harakati yo'q
  await call('a', 'POST', `/api/suppliers/${sup}/status`, { active: false });
  assert.equal((await call('s', 'POST', '/api/supplier-payments', { supplier_id: sup, kind: 'payment', amount: 1 })).status, 400);
  await call('a', 'POST', `/api/suppliers/${sup}/status`, { active: true });
});

test('tannarx harakatlanuvchi o\'rtacha (SAP MAP) bo\'yicha hisoblanadi', async () => {
  const p = async () => (await call('a', 'GET', '/api/products')).data.find((x) => x.id === pid);
  const before = await p(); // stock 10+200+100 = 310; cost avg
  const a1 = Math.round((10 * 3000 + 200 * 3100) / 210); // har kirimdan keyin o'rtacha yaxlitlanadi
  const expected = Math.round((210 * a1 + 100 * 3000) / 310);
  assert.equal(before.stock, 310); assert.equal(before.cost, expected);
  // 310 ta + 190 ta x 3200 -> yangi o'rtacha
  await call('s', 'POST', '/api/supplier-payments', { supplier_id: sup, kind: 'payment', amount: 1 }); // balans bilan o'ynash shart emas, faqat kassa
  await call('s', 'POST', '/api/receipts', { supplier_id: sup, items: [{ product_id: pid, qty: 190, cost: 3200 }] });
  assert.equal((await p()).cost, Math.round((310 * before.cost + 190 * 3200) / 500));
});

test('yetkazuvchisiz kirim kassadan to\'lanadi, storno kassaga qaytaradi; yetkazuvchili storno qarzni kamaytiradi', async () => {
  const c0 = await cash();
  const r = await call('a', 'POST', '/api/receipts', { items: [{ product_id: pid, qty: 10, cost: 3000 }] }); // naqd xarid 30 000
  assert.equal(await cash(), c0 - 30000);
  assert.equal((await call('a', 'POST', `/api/admin/receipts/${r.data.id}/reverse`)).status, 200);
  assert.equal(await cash(), c0);
  const b0 = (await supBal()).balance;
  const r2 = await call('a', 'POST', '/api/receipts', { supplier_id: sup, items: [{ product_id: pid, qty: 10, cost: 3000 }] });
  assert.equal((await supBal()).balance, b0 + 30000);
  await call('a', 'POST', `/api/admin/receipts/${r2.data.id}/reverse`);
  assert.equal((await supBal()).balance, b0);
  // kassa yetmasa naqd xarid rad etiladi
  const huge = await call('a', 'POST', '/api/receipts', { items: [{ product_id: pid, qty: 1000000, cost: 3000 }] });
  assert.equal(huge.status, 409); assert.match(huge.data.error, /Kassada mablag/);
});

test('sotuv kassaga kiradi (usul bo\'yicha), nasiya kiritmaydi; qaytarish va mijoz to\'lovi kassani to\'g\'ri o\'zgartiradi', async () => {
  const c0 = await cash(), k0 = await cash('card');
  const s = (await call('s', 'POST', '/api/sales', { items: [{ product_id: pid, qty: 5 }], method: 'card' })).data; // 20 000 karta
  assert.deepEqual([await cash(), await cash('card')], [c0, k0 + 20000]);
  const credit = (await call('s', 'POST', '/api/sales', { items: [{ product_id: pid, qty: 5 }], customer_id: cust, paid: 5000 })).data; // 20 000, 5 000 naqd, 15 000 nasiya
  assert.equal(await cash(), c0 + 5000);
  // nasiya to'lovi karta orqali
  await call('s', 'POST', `/api/customers/${cust}/payments`, { amount: 4000, method: 'card' });
  assert.equal(await cash('card'), k0 + 24000);
  // qaytarish: karta bilan sotilgan, 2 dona (8 000) kartaga qaytariladi
  const det = (await call('s', 'GET', `/api/sales/${s.id}`)).data;
  const ret = (await call('s', 'POST', '/api/returns', { sale_id: s.id, items: [{ sale_item_id: det.items[0].id, qty: 2 }] })).data;
  assert.deepEqual([ret.total, ret.cash_refund], [8000, 8000]);
  assert.equal(await cash('card'), k0 + 24000 - 8000);
  // qarzga o'tkaziladigan qaytarish: kassaga ta'sir qilmaydi
  const det2 = (await call('s', 'GET', `/api/sales/${credit.id}`)).data;
  const before = await cash();
  const r2 = (await call('s', 'POST', '/api/returns', { sale_id: credit.id, refund: 'debt', items: [{ sale_item_id: det2.items[0].id, qty: 1 }] })).data;
  assert.deepEqual([r2.to_debt, r2.cash_refund], [4000, 0]);
  assert.equal(await cash(), before);
});

test('xarajat va hisobdan chiqarish: kassa va foyda-zarar hisoboti', async () => {
  const c0 = await cash();
  assert.equal((await call('a', 'POST', '/api/admin/cash-operations', { kind: 'expense', category: 'rent', amount: 100000 })).status, 200);
  assert.equal((await call('a', 'POST', '/api/admin/cash-operations', { kind: 'expense', category: 'yoq', amount: 1 })).status, 400);
  assert.equal(await cash(), c0 - 100000);
  const cost = (await call('a', 'GET', '/api/products')).data.find((x) => x.id === pid).cost;
  const wo = await call('a', 'POST', '/api/admin/writeoffs', { product_id: pid, qty: 4, reason: 'damaged' });
  assert.equal(wo.data.total, 4 * cost);
  assert.equal((await call('a', 'POST', '/api/admin/writeoffs', { product_id: pid, qty: 99999, reason: 'lost' })).status, 409);
  assert.equal((await call('s', 'POST', '/api/admin/writeoffs', { product_id: pid, qty: 1, reason: 'lost' })).status, 403);

  const f = (await call('a', 'GET', '/api/admin/finance')).data;
  // tushum: 20 000 + 20 000 sotuv − 8 000 − 4 000 qaytarish = 28 000
  assert.deepEqual([f.pl.gross_sales, f.pl.returns, f.pl.revenue], [40000, 12000, 28000]);
  assert.equal(f.pl.gross_profit, f.pl.revenue - f.pl.cogs);
  assert.equal(f.pl.expenses_total, 100000); assert.equal(f.pl.writeoff_total, 4 * cost);
  assert.equal(f.pl.net_profit, f.pl.gross_profit - 100000 - 4 * cost);
  // pul oqimi: ochilish + kirim − chiqim = yopilish = kassa qoldiqlari yig'indisi
  assert.equal(f.cashflow.closing, f.cashflow.opening + f.cashflow.inflow - f.cashflow.outflow);
  assert.equal(f.cashflow.closing, f.position.cash);
  assert.equal(f.position.cash, (await db.one('SELECT SUM(balance)::bigint s FROM cash_accounts')).s);
  assert.ok(f.position.inventory > 0);
  const sum = (await call('a', 'GET', '/api/admin/summary')).data;
  assert.equal(sum.today.expenses, 100000); assert.equal(sum.today.net_profit, sum.today.profit - 100000 - 4 * cost);
  assert.equal(sum.cash.total, f.position.cash);
});

test('pul zanjiri bazada majburlanadi: kassasiz/daftarsiz hujjat o\'tmaydi; nazorat hisoboti toza', async () => {
  // hujjatsiz pul harakati
  await assert.rejects(() => db.run("INSERT INTO cash_ledger(method,kind,amount,user_id) VALUES('cash','sale',100,?)", [uid]), /check|violat/i);
  // kassa daftarisiz yetkazuvchi to'lovi
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO supplier_payments(supplier_id,kind,amount,user_id) VALUES(?,'payment',500,?) RETURNING id", [sup, uid])).id;
    await t.run("INSERT INTO supplier_ledger(supplier_id,kind,amount,supplier_payment_id) VALUES(?,'payment',-500,?)", [sup, id]);
  }, /kassa daftariga yozilmagan/);
  // yetkazuvchi daftarisiz
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO supplier_payments(supplier_id,kind,amount,user_id) VALUES(?,'payment',500,?) RETURNING id", [sup, uid])).id;
    await t.run("INSERT INTO cash_ledger(method,kind,amount,supplier_payment_id,user_id) VALUES('cash','supplier_payment',-500,?,?)", [id, uid]);
  }, /yetkazuvchi daftariga yozilmagan/);
  // sotuv to'lovi kassaga yozilmagan
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO sales(user_id,total,paid) VALUES(?,4000,4000) RETURNING id", [uid])).id;
    await t.run('INSERT INTO sale_items(sale_id,product_id,qty,price,line_total,cost) VALUES(?,?,1,4000,4000,3000)', [id, pid]);
    await t.run("INSERT INTO stock_moves(product_id,type,qty,sale_id,user_id) VALUES(?,'sale',-1,?,?)", [pid, id, uid]);
  }, /kassa daftariga mos emas/);
  // yetkazuvchili kirim yetkazuvchi daftarisiz
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO receipts(user_id,supplier_id,total) VALUES(?,?,3000) RETURNING id", [uid, sup])).id;
    await t.run('INSERT INTO receipt_items(receipt_id,product_id,qty,cost,line_total) VALUES(?,?,1,3000,3000)', [id, pid]);
    await t.run("INSERT INTO stock_moves(product_id,type,qty,receipt_id,user_id) VALUES(?,'receipt',1,?,?)", [pid, id, uid]);
  }, /yetkazuvchi daftariga mos emas/);
  // xarajat kassadan chiqmagan
  await violates(async (t) => { await t.run("INSERT INTO cash_operations(kind,category,amount,user_id) VALUES('expense','rent',100,?)", [uid]); }, /kassa daftariga yozilmagan/);
  // hisobdan chiqarish ombor harakatisiz
  await violates(async (t) => { await t.run("INSERT INTO writeoffs(product_id,qty,cost,total,reason,user_id) VALUES(?,1,3000,3000,'lost',?)", [pid, uid]); }, /ombor harakatiga mos emas/);
  // hujjatlar zanjiri: to'lov hujjati pul tomoni bilan
  const spId = (await db.one('SELECT id FROM supplier_payments ORDER BY id LIMIT 1')).id;
  const flow = (await call('a', 'GET', `/api/admin/document-flow?type=supplier_payment&id=${spId}`)).data;
  assert.equal(flow.supplier_ledger.length, 1); assert.equal(flow.cash.length, 1);
  const rId = (await db.one('SELECT id FROM receipts WHERE supplier_id IS NOT NULL ORDER BY id LIMIT 1')).id;
  assert.equal((await call('a', 'GET', `/api/admin/document-flow?type=receipt&id=${rId}`)).data.supplier_ledger.length, 1);
  const cId = (await db.one('SELECT id FROM receipts WHERE supplier_id IS NULL AND kind=\'receipt\' ORDER BY id LIMIT 1')).id;
  assert.equal((await call('a', 'GET', `/api/admin/document-flow?type=receipt&id=${cId}`)).data.cash.length, 1);
  const rep = (await call('a', 'GET', '/api/admin/integrity')).data;
  assert.deepEqual(rep.checks.filter((c) => c.violations), []);
  assert.equal(rep.ok, true);
});
