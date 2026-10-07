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
// SQL tranzaksiyasi (COMMIT paytidagi kechiktirilgan tekshiruvlar ham ushlanadi) rad etilishi kerak
const violates = (fn, re) => assert.rejects(() => db.tx(fn), (e) => re.test(e.message), `kutilgan xato: ${re}`);
const stockOf = async () => (await db.one('SELECT stock FROM products WHERE id=?', [pid])).stock;

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

test('boshlang\'ich qoldiq ham hujjat: opening kirim + ombor harakati', async () => {
  const r = await db.one("SELECT r.id, r.kind, r.total, (SELECT COUNT(*)::int FROM stock_moves m WHERE m.receipt_id=r.id AND m.type='opening') moves FROM receipts r");
  assert.deepEqual([r.kind, r.total, r.moves], ['opening', 30000, 1]);
  assert.equal(await stockOf(), 10);
});

test('"yo\'qdan bor" bo\'lmaydi: qoldiq va qarz hujjatsiz o\'zgarmaydi', async () => {
  await assert.rejects(() => db.run('UPDATE products SET stock = 999 WHERE id=?', [pid]), /to'g'ridan-to'g'ri/);
  await assert.rejects(() => db.run('UPDATE customers SET balance = 5000 WHERE id=?', [cust]), /to'g'ridan-to'g'ri/);
  // hujjatga bog'lanmagan ombor harakati
  await assert.rejects(() => db.run("INSERT INTO stock_moves(product_id,type,qty,user_id) VALUES(?,'receipt',5,?)", [pid, uid]), /check|violat/i);
  // hujjat turi bilan mos kelmaydigan havola (sotuv harakati kirimga bog'langan)
  const rid = (await db.one('SELECT id FROM receipts LIMIT 1')).id;
  await assert.rejects(() => db.run("INSERT INTO stock_moves(product_id,type,qty,receipt_id,user_id) VALUES(?,'sale',-1,?,?)", [pid, rid, uid]), /check|violat/i);
  assert.equal(await stockOf(), 10);
});

test('hujjat qatorlari, jami va ombor harakati bir-biriga teng bo\'lishi shart (tranzaksiya oxirida)', async () => {
  const sale = async (t, total) => (await t.one("INSERT INTO sales(user_id,total,paid) VALUES(?,?,?) RETURNING id", [uid, total, total])).id;
  // qatorsiz sotuv
  await violates(async (t) => { await sale(t, 4000); }, /qatorlar yo'q/);
  // jami qatorlarga teng emas
  await violates(async (t) => {
    const id = await sale(t, 9999);
    await t.run('INSERT INTO sale_items(sale_id,product_id,qty,price,line_total,cost) VALUES(?,?,1,4000,4000,3000)', [id, pid]);
    await t.run("INSERT INTO stock_moves(product_id,type,qty,sale_id,user_id) VALUES(?,'sale',-1,?,?)", [pid, id, uid]);
  }, /teng emas/);
  // qator bor, ombor harakati yo'q ("bordan yo'q": tovar hujjatsiz ketib qolmasin)
  await violates(async (t) => {
    const id = await sale(t, 4000);
    await t.run('INSERT INTO sale_items(sale_id,product_id,qty,price,line_total,cost) VALUES(?,?,1,4000,4000,3000)', [id, pid]);
  }, /ombor harakatlariga mos emas/);
  // nasiya daftarga yozilmagan
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO sales(user_id,customer_id,total,paid) VALUES(?,?,4000,0) RETURNING id", [uid, cust])).id;
    await t.run('INSERT INTO sale_items(sale_id,product_id,qty,price,line_total,cost) VALUES(?,?,1,4000,4000,3000)', [id, pid]);
    await t.run("INSERT INTO stock_moves(product_id,type,qty,sale_id,user_id) VALUES(?,'sale',-1,?,?)", [pid, id, uid]);
  }, /Nasiya summasi/);
  // kirim: jami yoki harakat mos emas
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO receipts(user_id,total) VALUES(?,5000) RETURNING id", [uid])).id;
    await t.run('INSERT INTO receipt_items(receipt_id,product_id,qty,cost,line_total) VALUES(?,?,2,3000,6000)', [id, pid]);
    await t.run("INSERT INTO stock_moves(product_id,type,qty,receipt_id,user_id) VALUES(?,'receipt',2,?,?)", [pid, id, uid]);
  }, /teng emas/);
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO receipts(user_id,total) VALUES(?,6000) RETURNING id", [uid])).id;
    await t.run('INSERT INTO receipt_items(receipt_id,product_id,qty,cost,line_total) VALUES(?,?,2,3000,6000)', [id, pid]);
  }, /ombor harakatlariga mos emas/);
  // kirim tasdiqlanmagan to'lov
  await violates(async (t) => { await t.run('INSERT INTO debt_payments(customer_id,user_id,amount) VALUES(?,?,100)', [cust, uid]); }, /daftariga yozilmagan/);
  assert.equal(await stockOf(), 10);
  assert.equal((await db.one('SELECT COUNT(*)::int c FROM sales')).c, 0); // hech narsa yarim holda qolmagan
});

test('manfiy qoldiq va ortiqcha qaytarish bazada rad etiladi', async () => {
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO sales(user_id,total,paid) VALUES(?,?,?) RETURNING id", [uid, 44000, 44000])).id;
    await t.run('INSERT INTO sale_items(sale_id,product_id,qty,price,line_total,cost) VALUES(?,?,11,4000,44000,3000)', [id, pid]);
    await t.run("INSERT INTO stock_moves(product_id,type,qty,sale_id,user_id) VALUES(?,'sale',-11,?,?)", [pid, id, uid]);
  }, /chk_stock_nonneg|check/i);
  // ortiqcha qaytarish (SQL orqali)
  const s = (await call('s', 'POST', '/api/sales', { items: [{ product_id: pid, qty: 2 }] })).data;
  const item = (await db.one('SELECT id FROM sale_items WHERE sale_id=?', [s.id])).id;
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO sales(user_id,kind,ref_sale_id,total) VALUES(?,'return',?,-12000) RETURNING id", [uid, s.id])).id;
    await t.run('INSERT INTO sale_items(sale_id,product_id,orig_item_id,qty,price,line_total,cost) VALUES(?,?,?,-3,4000,-12000,3000)', [id, pid, item]);
    await t.run("INSERT INTO stock_moves(product_id,type,qty,sale_id,user_id) VALUES(?,'return',3,?,?)", [pid, id, uid]);
  }, /oshib ketdi/);
  // boshqa mahsulotga yoki boshqa sotuvga bog'langan qaytarish
  const p2 = (await call('a', 'POST', '/api/products', { name: 'Boshqa', sku: '9', price: 100, cost: 50, stock: 5 })).data.id;
  await violates(async (t) => {
    const id = (await t.one("INSERT INTO sales(user_id,kind,ref_sale_id,total) VALUES(?,'return',?,-100) RETURNING id", [uid, s.id])).id;
    await t.run('INSERT INTO sale_items(sale_id,product_id,orig_item_id,qty,price,line_total,cost) VALUES(?,?,?,-1,100,-100,50)', [id, p2, item]);
  }, /mos emas/);
  // qaytarish asl sotuvsiz bo'lmaydi
  await assert.rejects(() => db.run("INSERT INTO sales(user_id,kind,total) VALUES(?,'return',-1)", [uid]), /check|violat/i);
});

test('buyurtma -> kirim -> storno zanjiri va "qabul qilindi" faqat kirim hujjati bilan', async () => {
  const before = await stockOf();
  const po = (await call('a', 'POST', '/api/admin/purchase-orders', { supplier_id: sup, items: [{ product_id: pid, qty: 6, cost: 3100 }] })).data;
  // kirimsiz "received" bo'lmaydi
  await assert.rejects(() => db.run("UPDATE purchase_orders SET status='received' WHERE id=?", [po.id]), /Kirim hujjatisiz/);
  const rec = (await call('a', 'POST', `/api/admin/purchase-orders/${po.id}/receive`)).data;
  assert.equal(await stockOf(), before + 6);
  let flow = (await call('a', 'GET', `/api/admin/document-flow?type=po&id=${po.id}`)).data;
  assert.deepEqual(flow.related.map((r) => [r.type, r.id, r.relation]), [['receipt', rec.id, 'Qabul qilingan kirim']]);
  flow = (await call('a', 'GET', `/api/admin/document-flow?type=receipt&id=${rec.id}`)).data;
  assert.equal(flow.related[0].relation, 'Buyurtma');
  assert.deepEqual([flow.moves.length, flow.moves[0].type, flow.moves[0].qty], [1, 'purchase', 6]);
  const rev = (await call('a', 'POST', `/api/admin/receipts/${rec.id}/reverse`)).data;
  assert.equal(await stockOf(), before);
  flow = (await call('a', 'GET', `/api/admin/document-flow?type=receipt&id=${rec.id}`)).data;
  assert.deepEqual(flow.related.map((r) => r.relation), ['Buyurtma', 'Storno hujjati']);
  flow = (await call('a', 'GET', `/api/admin/document-flow?type=receipt&id=${rev.id}`)).data;
  assert.deepEqual(flow.related.map((r) => r.relation), ['Asl kirim']);
  assert.equal(flow.moves[0].type, 'receipt_reversal');
});

test('sotuv -> qaytarish -> to\'lov zanjiri: hujjat oqimi va nazorat hisoboti toza', async () => {
  const s = (await call('s', 'POST', '/api/sales', { items: [{ product_id: pid, qty: 3 }], customer_id: cust, paid: 2000 })).data;
  const det = (await call('s', 'GET', `/api/sales/${s.id}`)).data;
  const ret = (await call('s', 'POST', '/api/returns', { sale_id: s.id, refund: 'debt', items: [{ sale_item_id: det.items[0].id, qty: 1 }] })).data;
  const pay = (await call('s', 'POST', `/api/customers/${cust}/payments`, { amount: 1000 })).data;
  let flow = (await call('a', 'GET', `/api/admin/document-flow?type=sale&id=${s.id}`)).data;
  assert.deepEqual(flow.related.map((r) => [r.relation, r.id]), [['Qaytarish', ret.id]]);
  assert.deepEqual([flow.moves[0].qty, flow.ledger[0].kind, flow.ledger[0].amount], [-3, 'sale_debt', 10000]);
  flow = (await call('a', 'GET', `/api/admin/document-flow?type=sale&id=${ret.id}`)).data;
  assert.deepEqual([flow.related[0].relation, flow.moves[0].qty, flow.ledger[0].kind, flow.ledger[0].amount], ['Asl sotuv', 1, 'return_credit', -4000]);
  flow = (await call('a', 'GET', `/api/admin/document-flow?type=payment&id=${pay.id}`)).data;
  assert.equal(flow.ledger[0].amount, -1000);
  assert.equal((await db.one('SELECT balance FROM customers WHERE id=?', [cust])).balance, 10000 - 4000 - 1000);
  assert.equal((await call('s', 'GET', '/api/admin/integrity')).status, 403);
  const rep = (await call('a', 'GET', '/api/admin/integrity')).data;
  assert.deepEqual(rep.checks.filter((c) => c.violations), []);
  assert.equal(rep.ok, true);
  assert.equal((await call('a', 'GET', '/api/admin/document-flow?type=sale&id=99999')).status, 404);
  assert.equal((await call('a', 'GET', '/api/admin/document-flow?type=xxx&id=1')).status, 400);
});

test('nazorat hisoboti buzilishni topadi (trigger o\'chirilgan holatda ham)', async () => {
  // ruxsatli yo'l bilan buzamiz: trigger'ni vaqtincha o'chirib stock'ni o'zgartiramiz (faqat test uchun)
  await db.exec('ALTER TABLE products DISABLE TRIGGER trg_guard_stock');
  await db.run('UPDATE products SET stock = stock + 7 WHERE id=?', [pid]);
  await db.exec('ALTER TABLE products ENABLE TRIGGER trg_guard_stock');
  const rep = (await call('a', 'GET', '/api/admin/integrity')).data;
  assert.equal(rep.ok, false);
  assert.deepEqual(rep.checks.filter((c) => c.violations).map((c) => c.key), ['stock']);
  assert.equal(rep.checks.find((c) => c.key === 'stock').samples[0].id, pid);
});
