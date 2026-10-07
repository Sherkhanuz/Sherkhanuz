import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, localDate, localHour, TZ, ensureReady } from './db.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const num = (v, name, { min = 0, int = false } = {}) => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw bad(`${name} noto'g'ri`);
  return n;
};
const str = (v, name, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${name} noto'g'ri`);
  return v.trim();
};
export const localToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const dateArg = (s, def) => {
  if (s == null) return def;
  if (!isDate(s) || Number.isNaN(Date.parse(s))) throw bad('sana noto\'g\'ri (YYYY-MM-DD)');
  return s;
};
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const isUnique = (e) => e?.code === '23505' || /unique|duplicate/i.test(e?.message || '');

export function createHandler(db) {
  const LS = localDate('s.created_at');
  const routes = [];
  const route = (method, path, roles, handler) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, roles, handler });
  };
  const idArg = (v) => num(v, 'id', { int: true, min: 1 });
  // Barcha yozuvlar tranzaksiyada; foydalanuvchi id si change_log trigger'i uchun saqlanadi
  const txu = (user, fn) => db.tx(async (t) => { await t.q("SELECT set_config('app.user_id', ?, true)", [String(user.id)]); return fn(t); });

  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  // Ombor daftariga yozuv (products.stock'ni baza triggeri yangilaydi; to'g'ridan-to'g'ri o'zgartirish taqiqlangan)
  const moveStock = (t, { product_id, type, qty, sale_id = null, receipt_id = null, writeoff_id = null, user }) =>
    t.run('INSERT INTO stock_moves(product_id,type,qty,sale_id,receipt_id,writeoff_id,user_id) VALUES(?,?,?,?,?,?,?)', [product_id, type, r6(qty), sale_id, receipt_id, writeoff_id, user.id]);
  const METHODS = ['cash', 'card', 'transfer'];
  const methodArg = (v) => (v == null || v === '' ? 'cash' : METHODS.includes(v) ? v : (() => { throw bad('To\'lov usuli noto\'g\'ri (cash/card/transfer)'); })());
  // Kassa daftari: har bir pul harakati aynan bitta hujjatga bog'langan; kassa qoldig'ini baza triggeri yangilaydi (manfiy bo'la olmaydi)
  const cashEntry = (t, { method, kind, amount, user, sale_id = null, debt_payment_id = null, supplier_payment_id = null, receipt_id = null, cash_operation_id = null }) =>
    amount === 0 ? null : t.run('INSERT INTO cash_ledger(method,kind,amount,sale_id,debt_payment_id,supplier_payment_id,receipt_id,cash_operation_id,user_id) VALUES(?,?,?,?,?,?,?,?,?)',
      [method, kind, amount, sale_id, debt_payment_id, supplier_payment_id, receipt_id, cash_operation_id, user.id]);
  // Yetkazuvchi daftari: musbat = biz qarzdormiz, manfiy = yetkazuvchida bizning avansimiz
  const supLedger = (t, { supplier_id, kind, amount, receipt_id = null, supplier_payment_id = null }) =>
    amount === 0 ? null : t.run('INSERT INTO supplier_ledger(supplier_id,kind,amount,receipt_id,supplier_payment_id) VALUES(?,?,?,?,?)', [supplier_id, kind, amount, receipt_id, supplier_payment_id]);
  const supplierBalance = async (t, id) => (await t.one('SELECT COALESCE(SUM(amount),0)::bigint AS b FROM supplier_ledger WHERE supplier_id=?', [id])).b;
  const ledger = (t, { customer_id, kind, amount, sale_id = null, debt_payment_id = null }) =>
    t.run('INSERT INTO customer_ledger(customer_id,kind,amount,sale_id,debt_payment_id) VALUES(?,?,?,?,?)', [customer_id, kind, amount, sale_id, debt_payment_id]);

  // ---------- Auth ----------
  const WINDOW = "interval '15 minutes'";
  route('POST', '/api/login', null, async ({ body, ip, res, secure }) => {
    const blocked = await db.one(`SELECT n FROM login_attempts WHERE ip=? AND t > now() - ${WINDOW} AND n >= 10`, [ip]);
    if (blocked) throw new HttpError(429, 'Juda ko\'p urinish, keyinroq qayta urining');
    const u = await db.one('SELECT * FROM users WHERE username=? AND active', [String(body.username || '')]);
    if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) {
      await db.run(`INSERT INTO login_attempts(ip,n,t) VALUES(?,1,now()) ON CONFLICT (ip) DO UPDATE SET
        n = CASE WHEN login_attempts.t < now() - ${WINDOW} THEN 1 ELSE login_attempts.n + 1 END,
        t = CASE WHEN login_attempts.t < now() - ${WINDOW} THEN now() ELSE login_attempts.t END`, [ip]);
      throw new HttpError(401, 'Login yoki parol xato');
    }
    await db.run('UPDATE login_attempts SET n=0 WHERE ip=?', [ip]);
    const token = randomBytes(32).toString('hex');
    await db.run('INSERT INTO sessions(token,user_id) VALUES(?,?)', [token, u.id]);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}${secure ? '; Secure' : ''}`);
    return { id: u.id, name: u.name, role: u.role };
  });
  route('POST', '/api/logout', [], async ({ req, res }) => {
    await db.run('UPDATE sessions SET revoked=TRUE WHERE token=?', [cookie(req).sid || '']);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return { ok: true };
  });
  route('GET', '/api/me', [], ({ user }) => user);

  // ---------- Mahsulotlar / ombor ----------
  // Holat filtri: faqat admin noaktivlarni ko'ra oladi; boshqa hamma joyda faqat aktiv
  const statusWhere = (q, user, col = 'active') => (user.role !== 'admin' || !q.status || q.status === 'active' ? col : q.status === 'inactive' ? `NOT ${col}` : 'TRUE');
  route('GET', '/api/products', ['admin', 'seller'], ({ user, query }) => {
    const cols = user.role === 'admin' ? '*' : 'id,sku,name,category,unit,price,stock,min_stock,active';
    return db.q(`SELECT ${cols} FROM products WHERE ${statusWhere(query, user)} ORDER BY name`);
  });
  const productBody = (b) => ({
    sku: b.sku ? str(b.sku, 'SKU / shtrixkod', 50) : null, name: str(b.name, 'Nomi'),
    category: String(b.category || '').slice(0, 80), unit: str(b.unit || 'dona', 'Birlik', 20),
    price: num(b.price, 'Narx', { int: true }), cost: num(b.cost ?? 0, 'Tannarx', { int: true }),
    min_stock: num(b.min_stock ?? 0, 'Minimal qoldiq'),
  });
  route('POST', '/api/products', ['admin'], async ({ body, user }) => {
    const p = productBody(body);
    const stock = num(body.stock ?? 0, 'Qoldiq');
    try {
      return await txu(user, async (t) => {
        const { id } = await t.one(`INSERT INTO products(sku,name,category,unit,price,cost,min_stock)
          VALUES(?,?,?,?,?,?,?) RETURNING id`, [p.sku, p.name, p.category, p.unit, p.price, p.cost, p.min_stock]);
        // Boshlang'ich qoldiq ham hujjat: 'opening' kirimi (hujjatsiz qoldiq bo'lmaydi)
        if (stock > 0) await receiveStock(t, { items: [{ product_id: id, qty: stock, cost: p.cost }], supplier_id: null, note: 'Boshlang\'ich qoldiq', user, kind: 'opening' });
        return { id };
      });
    } catch (e) { if (isUnique(e)) throw bad('Bu SKU band'); throw e; }
  });
  route('PUT', '/api/products/:id', ['admin'], async ({ body, params, user }) => {
    const p = productBody(body);
    try {
      const n = await txu(user, (t) => t.run(`UPDATE products SET sku=?,name=?,category=?,unit=?,price=?,cost=?,min_stock=? WHERE id=?`,
        [p.sku, p.name, p.category, p.unit, p.price, p.cost, p.min_stock, idArg(params.id)]));
      if (!n) throw new HttpError(404, 'Mahsulot topilmadi');
    } catch (e) { if (isUnique(e)) throw bad('Bu SKU band'); throw e; }
    return { ok: true };
  });

  // Holat o'zgartirish (o'chirish o'rniga). Noaktiv bo'lsa yangi hujjatlarda ishlatib bo'lmaydi, tarix saqlanadi.
  route('POST', '/api/products/:id/status', ['admin'], ({ params, body, user }) => txu(user, async (t) => {
    if (typeof body.active !== 'boolean') throw bad('active (true/false) kerak');
    const id = idArg(params.id);
    const p = await t.one('SELECT id,name,stock,active FROM products WHERE id=? FOR UPDATE', [id]);
    if (!p) throw new HttpError(404, 'Mahsulot topilmadi');
    if (!body.active && p.active) {
      if (p.stock !== 0) throw new HttpError(409, `Qoldiq ${p.stock} — noaktiv qilishdan oldin qoldiq 0 bo'lishi kerak`);
      if (await t.one("SELECT 1 x FROM po_items i JOIN purchase_orders o ON o.id=i.po_id WHERE i.product_id=? AND o.status='ordered' LIMIT 1", [id])) throw new HttpError(409, 'Mahsulot ochiq buyurtmada bor');
    }
    await t.run('UPDATE products SET active=? WHERE id=?', [body.active, id]);
    return { ok: true, active: body.active };
  }));

  // ---------- Yetkazib beruvchilar va mijozlar ----------
  route('GET', '/api/suppliers', ['admin', 'seller'], ({ user, query }) => db.q(`SELECT s.*, COALESCE((SELECT SUM(l.amount) FROM supplier_ledger l WHERE l.supplier_id=s.id),0)::bigint AS balance
    FROM suppliers s WHERE ${statusWhere(query, user, 's.active')} ORDER BY s.name`));
  route('POST', '/api/suppliers', ['admin', 'seller'], async ({ body, user }) => {
    try {
      return await txu(user, (t) => t.one('INSERT INTO suppliers(name,phone) VALUES(?,?) RETURNING id', [str(body.name, 'Nomi'), String(body.phone || '').slice(0, 40)]));
    } catch (e) { if (isUnique(e)) throw bad('Bunday yetkazib beruvchi bor'); throw e; }
  });
  route('POST', '/api/suppliers/:id/status', ['admin'], ({ params, body, user }) => txu(user, async (t) => {
    if (typeof body.active !== 'boolean') throw bad('active (true/false) kerak');
    const id = idArg(params.id);
    if (!body.active && await t.one("SELECT 1 x FROM purchase_orders WHERE supplier_id=? AND status='ordered' LIMIT 1", [id])) throw new HttpError(409, 'Ochiq buyurtmasi bor yetkazib beruvchini noaktiv qilib bo\'lmaydi');
    if (!(await t.run('UPDATE suppliers SET active=? WHERE id=?', [body.active, id]))) throw new HttpError(404, 'Topilmadi');
    return { ok: true, active: body.active };
  }));
  route('GET', '/api/customers', ['admin', 'seller'], ({ user, query }) => db.q(`SELECT id,name,phone,balance,active FROM customers WHERE ${statusWhere(query, user)} ORDER BY name`));
  route('POST', '/api/customers', ['admin', 'seller'], ({ body, user }) =>
    txu(user, (t) => t.one('INSERT INTO customers(name,phone) VALUES(?,?) RETURNING id', [str(body.name, 'Ism', 80), String(body.phone || '').slice(0, 40)])));
  route('POST', '/api/customers/:id/status', ['admin'], ({ params, body, user }) => txu(user, async (t) => {
    if (typeof body.active !== 'boolean') throw bad('active (true/false) kerak');
    const c = await t.one('SELECT id,balance FROM customers WHERE id=? FOR UPDATE', [idArg(params.id)]);
    if (!c) throw new HttpError(404, 'Mijoz topilmadi');
    if (!body.active && c.balance > 0) throw new HttpError(409, `Mijozning qarzi bor (${c.balance}) — avval to'lov qabul qiling`);
    await t.run('UPDATE customers SET active=? WHERE id=?', [body.active, c.id]);
    return { ok: true, active: body.active };
  }));
  route('POST', '/api/customers/:id/payments', ['admin', 'seller'], ({ body, params, user }) => {
    const amount = num(body.amount, 'Summa', { int: true, min: 1 });
    return txu(user, async (t) => {
      const c = await t.one('SELECT id,balance FROM customers WHERE id=? FOR UPDATE', [idArg(params.id)]);
      if (!c) throw new HttpError(404, 'Mijoz topilmadi');
      if (amount > c.balance) throw new HttpError(409, 'Summa mijoz qarzidan oshib ketdi');
      const method = methodArg(body.method);
      const { id } = await t.one('INSERT INTO debt_payments(customer_id,user_id,amount,method) VALUES(?,?,?,?) RETURNING id', [c.id, user.id, amount, method]);
      await ledger(t, { customer_id: c.id, kind: 'payment', amount: -amount, debt_payment_id: id });
      await cashEntry(t, { method, kind: 'debt_payment', amount, debt_payment_id: id, user }); // mijozdan olingan pul kassaga
      return { id, balance: c.balance - amount };
    });
  });

  // ---------- Sotuv ----------
  const lines = (arr, { cost = false } = {}) => {
    if (!Array.isArray(arr) || !arr.length || arr.length > 200) throw bad('Mahsulotlar ro\'yxati bo\'sh');
    const seen = new Set();
    return arr.map((l) => {
      const product_id = num(l.product_id, 'Mahsulot', { int: true, min: 1 });
      if (seen.has(product_id)) throw bad('Bir mahsulot ikki marta kiritilgan');
      seen.add(product_id);
      const qty = num(l.qty, 'Miqdor');
      if (qty <= 0) throw bad('Miqdor 0 dan katta bo\'lishi kerak');
      return { product_id, qty, cost: cost ? num(l.cost, 'Tannarx', { int: true }) : undefined };
    }).sort((a, b) => a.product_id - b.product_id); // bir xil tartibda qulflash — deadlock bo'lmasin
  };
  route('POST', '/api/sales', ['admin', 'seller'], ({ body, user }) => {
    const items = lines(body.items);
    const method = ['cash', 'card', 'transfer'].includes(body.method) ? body.method : 'cash';
    const customer_id = body.customer_id ? idArg(body.customer_id) : null;
    return txu(user, async (t) => {
      const rows = [];
      let subtotal = 0;
      for (const it of items) {
        const p = await t.one('SELECT id,name,price,cost,stock FROM products WHERE id=? AND active FOR UPDATE', [it.product_id]);
        if (!p) throw bad('Mahsulot topilmadi yoki noaktiv');
        if (p.stock < it.qty) throw new HttpError(409, `"${p.name}" omborda yetarli emas (qoldiq: ${p.stock})`);
        const gross = Math.round(p.price * it.qty);
        subtotal += gross;
        rows.push({ p, qty: it.qty, gross });
      }
      let discount = 0;
      if (body.discount_type === 'percent') {
        const pc = num(body.discount ?? 0, 'Chegirma', { min: 0 });
        if (pc > 100) throw bad('Chegirma 100% dan oshmasin');
        discount = Math.round(subtotal * pc / 100);
      } else discount = num(body.discount ?? 0, 'Chegirma', { int: true });
      if (discount > subtotal) throw bad('Chegirma summadan oshib ketdi');
      const total = subtotal - discount;
      const paid = body.paid == null || body.paid === '' ? total : num(body.paid, 'To\'langan', { int: true });
      if (paid > total) throw bad('To\'langan summa jami summadan oshmasin');
      if (paid < total && !customer_id) throw bad('Nasiya uchun mijozni tanlang');
      if (customer_id && !(await t.one('SELECT 1 x FROM customers WHERE id=? AND active', [customer_id]))) throw bad('Mijoz topilmadi yoki noaktiv');

      const { id: sid } = await t.one('INSERT INTO sales(user_id,customer_id,discount,total,paid,method) VALUES(?,?,?,?,?,?) RETURNING id',
        [user.id, customer_id, discount, total, paid, method]);
      let left = total;
      for (const [i, r] of rows.entries()) {
        // chegirma qatorlarga proporsional taqsimlanadi, qoldiq oxirgi qatorga
        const line = i === rows.length - 1 ? left : (subtotal ? Math.round(r.gross * total / subtotal) : 0);
        left -= line;
        await t.run('INSERT INTO sale_items(sale_id,product_id,qty,price,line_total,cost) VALUES(?,?,?,?,?,?)', [sid, r.p.id, r.qty, r.p.price, line, r.p.cost]);
        await moveStock(t, { product_id: r.p.id, type: 'sale', qty: -r.qty, sale_id: sid, user });
      }
      if (paid < total) await ledger(t, { customer_id, kind: 'sale_debt', amount: total - paid, sale_id: sid });
      await cashEntry(t, { method, kind: 'sale', amount: paid, sale_id: sid, user }); // to'langan pul kassaga
      return { id: sid, subtotal, discount, total, paid, debt: total - paid };
    });
  });

  const ITEMS_TXT = `(SELECT string_agg(p.name || ' ×' || i.qty::text, ', ' ORDER BY i.id) FROM sale_items i JOIN products p ON p.id=i.product_id WHERE i.sale_id=s.id)`;
  route('GET', '/api/sales', ['admin', 'seller'], ({ query, user }) => {
    const date = dateArg(query.date, localToday());
    const own = user.role === 'seller' ? 'AND s.user_id=?' : '';
    return db.q(`SELECT s.id,s.kind,s.total,s.discount,s.paid,s.method,s.created_at,u.name seller,c.name customer, ${ITEMS_TXT} items
      FROM sales s JOIN users u ON u.id=s.user_id LEFT JOIN customers c ON c.id=s.customer_id
      WHERE ${LS} = ?::date ${own} ORDER BY s.id DESC LIMIT 500`, user.role === 'seller' ? [date, user.id] : [date]);
  });
  // Bitta sotuv va uning qaytarilishi mumkin bo'lgan qoldig'i
  route('GET', '/api/sales/:id', ['admin', 'seller'], async ({ params }) => {
    const s = await db.one(`SELECT s.id,s.kind,s.total,s.discount,s.paid,s.method,s.created_at,s.customer_id,c.name customer
      FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?`, [idArg(params.id)]);
    if (!s) throw new HttpError(404, 'Sotuv topilmadi');
    s.items = await db.q(`SELECT i.id,i.product_id,p.name,p.unit,i.qty,i.price,i.line_total,
        i.qty - COALESCE((SELECT -SUM(r.qty) FROM sale_items r WHERE r.orig_item_id=i.id),0) returnable
      FROM sale_items i JOIN products p ON p.id=i.product_id WHERE i.sale_id=? ORDER BY i.id`, [s.id]);
    return s;
  });

  // ---------- Qaytarish ----------
  route('POST', '/api/returns', ['admin', 'seller'], ({ body, user }) => {
    if (!Array.isArray(body.items) || !body.items.length) throw bad('Qaytariladigan mahsulot yo\'q');
    const toDebt = body.refund === 'debt';
    const sale_id = idArg(body.sale_id);
    return txu(user, async (t) => {
      const sale = await t.one("SELECT id,customer_id,method FROM sales WHERE id=? AND kind='sale' FOR UPDATE", [sale_id]);
      if (!sale) throw new HttpError(404, 'Sotuv topilmadi');
      if (toDebt && !sale.customer_id) throw bad('Bu sotuvda mijoz yo\'q');
      const picked = [];
      const seen = new Set();
      for (const l of body.items) {
        const iid = idArg(l.sale_item_id);
        if (seen.has(iid)) throw bad('Bir qator ikki marta kiritilgan');
        seen.add(iid);
        const qty = num(l.qty, 'Miqdor');
        if (qty <= 0) continue;
        const it = await t.one('SELECT * FROM sale_items WHERE id=? AND sale_id=?', [iid, sale_id]);
        if (!it) throw bad('Qator bu sotuvga tegishli emas');
        const done = (await t.one('SELECT COALESCE(-SUM(qty),0) q FROM sale_items WHERE orig_item_id=?', [iid])).q;
        if (qty > it.qty - done + 1e-9) throw new HttpError(409, 'Qaytariladigan miqdor sotilganidan oshib ketdi');
        picked.push({ it, qty, amount: Math.round(it.line_total * qty / it.qty) });
      }
      if (!picked.length) throw bad('Qaytariladigan miqdor kiritilmagan');
      const total = picked.reduce((a, r) => a + r.amount, 0);
      const { id } = await t.one("INSERT INTO sales(user_id,kind,ref_sale_id,customer_id,total,paid,method) VALUES(?,'return',?,?,?,0,?) RETURNING id",
        [user.id, sale_id, sale.customer_id, -total, sale.method]);
      for (const r of picked) {
        await t.run('INSERT INTO sale_items(sale_id,product_id,orig_item_id,qty,price,line_total,cost) VALUES(?,?,?,?,?,?,?)',
          [id, r.it.product_id, r.it.id, -r.qty, r.it.price, -r.amount, r.it.cost]);
        await moveStock(t, { product_id: r.it.product_id, type: 'return', qty: r.qty, sale_id: id, user });
      }
      let toDebtAmt = 0;
      if (toDebt) { // qaytarilgan summa avval mijoz qarzini kamaytiradi, ortig'i naqd qaytariladi
        const c = await t.one('SELECT balance FROM customers WHERE id=? FOR UPDATE', [sale.customer_id]);
        toDebtAmt = Math.min(total, c.balance);
        if (toDebtAmt) await ledger(t, { customer_id: sale.customer_id, kind: 'return_credit', amount: -toDebtAmt, sale_id: id });
      }
      // qarzga o'tmagan qismi asl sotuv usuli bo'yicha kassadan qaytariladi
      await cashEntry(t, { method: sale.method, kind: 'return_refund', amount: -(total - toDebtAmt), sale_id: id, user });
      return { id, total, to_debt: toDebtAmt, cash_refund: total - toDebtAmt };
    });
  });

  // ---------- Kirim ----------
  // Kirim hujjati: qatorlar + ombor daftari + pul tomoni. kind: receipt | opening; po_id — buyurtma bo'yicha bo'lsa.
  // Pul: yetkazuvchili kirim yetkazuvchi daftariga yoziladi (avansdan avtomatik ayriladi); yetkazuvchisiz kirim kassadan to'lanadi (naqd xarid).
  // Tannarx: harakatlanuvchi o'rtacha (SAP MAP): yangi = (qoldiq*tannarx + kirim*narx) / (qoldiq + kirim)
  const receiveStock = async (t, { items, supplier_id, note, user, source = 'receipt', kind = 'receipt', po_id = null, pay_method = 'cash' }) => {
    const lines = items.map((it) => ({ ...it, line_total: Math.round(it.cost * it.qty) }));
    const total = lines.reduce((a, l) => a + l.line_total, 0); // hujjat o'zgarmas: jami oldindan
    const { id: rid } = await t.one('INSERT INTO receipts(user_id,kind,supplier_id,po_id,pay_method,note,total) VALUES(?,?,?,?,?,?,?) RETURNING id', [user.id, kind, supplier_id ?? null, po_id, pay_method, note, total]);
    for (const it of lines) {
      const p = await t.one('SELECT id,stock,cost FROM products WHERE id=? AND active FOR UPDATE', [it.product_id]);
      if (!p) throw bad('Mahsulot topilmadi yoki noaktiv');
      await t.run('INSERT INTO receipt_items(receipt_id,product_id,qty,cost,line_total) VALUES(?,?,?,?,?)', [rid, it.product_id, it.qty, it.cost, it.line_total]);
      await moveStock(t, { product_id: it.product_id, type: kind === 'opening' ? 'opening' : source, qty: it.qty, receipt_id: rid, user });
      if (kind !== 'opening') {
        const avg = Math.round((p.stock * p.cost + it.qty * it.cost) / (p.stock + it.qty));
        await t.run('UPDATE products SET cost=? WHERE id=?', [avg, it.product_id]);
      }
    }
    if (kind !== 'opening') {
      if (supplier_id) await supLedger(t, { supplier_id, kind: 'receipt', amount: total, receipt_id: rid });
      else await cashEntry(t, { method: pay_method, kind: 'cash_purchase', amount: -total, receipt_id: rid, user });
    }
    return { id: rid, total };
  };
  route('POST', '/api/receipts', ['admin', 'seller'], async ({ body, user }) => {
    const items = lines(body.items, { cost: true });
    if (items.some((it) => !(it.cost > 0))) throw bad('Kirim narxini kiriting (0 bo\'lmasin): u o\'rtacha tannarx va foydani belgilaydi');
    const supplier_id = body.supplier_id ? idArg(body.supplier_id) : null;
    if (supplier_id && !(await db.one('SELECT 1 x FROM suppliers WHERE id=? AND active', [supplier_id]))) throw bad('Yetkazib beruvchi topilmadi yoki noaktiv');
    return txu(user, (t) => receiveStock(t, { items, supplier_id, note: String(body.note || '').slice(0, 300), user, source: 'receipt', pay_method: methodArg(body.pay_method) }));
  });
  route('GET', '/api/receipts', ['admin', 'seller'], ({ query, user }) => {
    const date = dateArg(query.date, localToday());
    const own = user.role === 'seller' ? 'AND r.user_id=?' : '';
    return db.q(`SELECT r.id,r.kind,r.ref_receipt_id,r.pay_method,r.total,r.note,r.created_at,u.name "user",sp.name supplier,
        (SELECT string_agg(p.name || ' ×' || i.qty::text, ', ' ORDER BY i.id) FROM receipt_items i JOIN products p ON p.id=i.product_id WHERE i.receipt_id=r.id) items
      FROM receipts r JOIN users u ON u.id=r.user_id LEFT JOIN suppliers sp ON sp.id=r.supplier_id
      WHERE ${localDate('r.created_at')} = ?::date ${own} ORDER BY r.id DESC LIMIT 500`, user.role === 'seller' ? [date, user.id] : [date]);
  });

  // Kirimni storno qilish (SAP: MIGO 102): asl hujjat o'zgarmaydi, teskari hujjat yaratiladi
  route('POST', '/api/admin/receipts/:id/reverse', ['admin'], ({ params, user }) => txu(user, async (t) => {
    const r = await t.one("SELECT * FROM receipts WHERE id=? AND kind='receipt' FOR UPDATE", [idArg(params.id)]);
    if (!r) throw new HttpError(404, 'Kirim topilmadi');
    if (await t.one('SELECT 1 x FROM receipts WHERE ref_receipt_id=?', [r.id])) throw new HttpError(409, 'Bu kirim allaqachon storno qilingan');
    const items = await t.q('SELECT i.product_id,i.qty,i.cost,i.line_total,p.name FROM receipt_items i JOIN products p ON p.id=i.product_id WHERE i.receipt_id=? ORDER BY i.product_id', [r.id]);
    const { id } = await t.one("INSERT INTO receipts(user_id,supplier_id,kind,ref_receipt_id,pay_method,note,total) VALUES(?,?,'reversal',?,?,?,?) RETURNING id",
      [user.id, r.supplier_id, r.id, r.pay_method, `Storno: kirim #${r.id}`, -r.total]);
    for (const it of items) {
      const cur = await t.one('SELECT stock FROM products WHERE id=? FOR UPDATE', [it.product_id]);
      if (cur.stock < it.qty) throw new HttpError(409, `"${it.name}" omborda yetarli emas — storno mumkin emas (tovar allaqachon sotilgan)`);
      await t.run('INSERT INTO receipt_items(receipt_id,product_id,qty,cost,line_total) VALUES(?,?,?,?,?)', [id, it.product_id, -it.qty, it.cost, -it.line_total]);
      await moveStock(t, { product_id: it.product_id, type: 'receipt_reversal', qty: -it.qty, receipt_id: id, user });
    }
    if (r.supplier_id) await supLedger(t, { supplier_id: r.supplier_id, kind: 'receipt_reversal', amount: -r.total, receipt_id: id });
    else await cashEntry(t, { method: r.pay_method, kind: 'purchase_reversal', amount: r.total, receipt_id: id, user }); // naqd xarid puli kassaga qaytadi
    return { id, total: -r.total };
  }));


  // ---------- Yetkazuvchi hisobi: avans, qarz, pul qaytarish ----------
  // balans > 0: biz yetkazuvchidan qarzdormiz; balans < 0: yetkazuvchida bizning avansimiz (pulimiz) bor
  route('GET', '/api/suppliers/:id/account', ['admin', 'seller'], async ({ params }) => {
    const sup = await db.one('SELECT id,name,phone,active FROM suppliers WHERE id=?', [idArg(params.id)]);
    if (!sup) throw new HttpError(404, 'Yetkazib beruvchi topilmadi');
    const rows = await db.q(`SELECT l.id,l.kind,l.amount,l.receipt_id,l.supplier_payment_id,l.created_at,p.method,p.note,u.name "user",r.pay_method
      FROM supplier_ledger l LEFT JOIN supplier_payments p ON p.id=l.supplier_payment_id LEFT JOIN receipts r ON r.id=l.receipt_id
      LEFT JOIN users u ON u.id=COALESCE(p.user_id, r.user_id) WHERE l.supplier_id=? ORDER BY l.id`, [sup.id]);
    let bal = 0; for (const e of rows) { bal += e.amount; e.balance_after = bal; }
    return { supplier: sup, balance: bal, advance: Math.max(-bal, 0), payable: Math.max(bal, 0), entries: rows.reverse().slice(0, 200) };
  });
  // pul berish (avans yoki qarzni to'lash): kassadan chiqadi. pul qaytarib olish: yetkazuvchidagi avansdan, kassaga kiradi
  route('POST', '/api/supplier-payments', ['admin', 'seller'], ({ body, user }) => {
    const kind = body.kind === 'refund' ? 'refund' : body.kind === 'payment' ? 'payment' : (() => { throw bad("kind: payment | refund"); })();
    const amount = num(body.amount, 'Summa', { int: true, min: 1 });
    const method = methodArg(body.method);
    return txu(user, async (t) => {
      const sup = await t.one('SELECT id,active FROM suppliers WHERE id=? FOR UPDATE', [idArg(body.supplier_id)]);
      if (!sup || !sup.active) throw bad('Yetkazib beruvchi topilmadi yoki noaktiv');
      const bal = await supplierBalance(t, sup.id);
      if (kind === 'refund' && amount > -bal) throw new HttpError(409, `Yetkazuvchida avans yetarli emas (avans: ${Math.max(-bal, 0)} so'm)`);
      const { id } = await t.one('INSERT INTO supplier_payments(supplier_id,kind,amount,method,note,user_id) VALUES(?,?,?,?,?,?) RETURNING id',
        [sup.id, kind, amount, method, String(body.note || '').slice(0, 300), user.id]);
      const sign = kind === 'payment' ? -1 : 1;
      await supLedger(t, { supplier_id: sup.id, kind, amount: sign * amount, supplier_payment_id: id });
      await cashEntry(t, { method, kind: kind === 'payment' ? 'supplier_payment' : 'supplier_refund', amount: sign * amount, supplier_payment_id: id, user });
      return { id, balance: bal + sign * amount };
    });
  });

  // ---------- Kassa ----------
  route('GET', '/api/cash', ['admin', 'seller'], async ({ query }) => {
    const date = dateArg(query.date, localToday());
    const CL = localDate('c.created_at');
    const accounts = await db.q('SELECT method,balance FROM cash_accounts ORDER BY method');
    const day = await db.one(`SELECT COALESCE(SUM(amount) FILTER (WHERE amount>0),0)::bigint AS inflow, COALESCE(-SUM(amount) FILTER (WHERE amount<0),0)::bigint AS outflow
      FROM cash_ledger c WHERE ${CL} = ?::date`, [date]);
    const entries = await db.q(`SELECT c.id,c.method,c.kind,c.amount,c.created_at,u.name "user",
        CASE WHEN c.sale_id IS NOT NULL THEN 'sale' WHEN c.debt_payment_id IS NOT NULL THEN 'payment' WHEN c.supplier_payment_id IS NOT NULL THEN 'supplier_payment'
             WHEN c.receipt_id IS NOT NULL THEN 'receipt' ELSE 'cash_op' END AS ref_type,
        COALESCE(c.sale_id,c.debt_payment_id,c.supplier_payment_id,c.receipt_id,c.cash_operation_id) AS ref_id,
        COALESCE(co.category, sp.note, co.note) AS note, sup.name AS supplier
      FROM cash_ledger c JOIN users u ON u.id=c.user_id LEFT JOIN cash_operations co ON co.id=c.cash_operation_id
      LEFT JOIN supplier_payments sp ON sp.id=c.supplier_payment_id LEFT JOIN suppliers sup ON sup.id=sp.supplier_id
      WHERE ${CL} = ?::date ORDER BY c.id DESC LIMIT 500`, [date]);
    return { date, accounts, total: accounts.reduce((a, x) => a + x.balance, 0), inflow: day.inflow, outflow: day.outflow, entries };
  });
  const EXPENSE_CATS = ['rent', 'salary', 'utilities', 'transport', 'tax', 'marketing', 'other'];
  // xarajat (foydadan ayriladi), egasi pul kiritishi/olishi (foydaga ta'sir qilmaydi)
  route('POST', '/api/admin/cash-operations', ['admin'], ({ body, user }) => {
    const kind = ['expense', 'owner_deposit', 'owner_withdrawal'].includes(body.kind) ? body.kind : (() => { throw bad('kind: expense | owner_deposit | owner_withdrawal'); })();
    const amount = num(body.amount, 'Summa', { int: true, min: 1 });
    const method = methodArg(body.method);
    const category = kind === 'expense' ? (EXPENSE_CATS.includes(body.category) ? body.category : (() => { throw bad('Xarajat turi noto\'g\'ri'); })()) : null;
    return txu(user, async (t) => {
      const { id } = await t.one('INSERT INTO cash_operations(kind,category,amount,method,note,user_id) VALUES(?,?,?,?,?,?) RETURNING id',
        [kind, category, amount, method, String(body.note || '').slice(0, 300), user.id]);
      await cashEntry(t, { method, kind, amount: kind === 'owner_deposit' ? amount : -amount, cash_operation_id: id, user });
      return { id };
    });
  });
  route('GET', '/api/admin/cash-operations', ['admin'], ({ query }) => {
    const to = dateArg(query.to, localToday()); const from = dateArg(query.from, addDays(to, -29));
    return db.q(`SELECT o.id,o.kind,o.category,o.amount,o.method,o.note,o.created_at,u.name "user" FROM cash_operations o JOIN users u ON u.id=o.user_id
      WHERE ${localDate('o.created_at')} BETWEEN ?::date AND ?::date ORDER BY o.id DESC LIMIT 500`, [from, to]);
  });

  // ---------- Hisobdan chiqarish (brak, muddati o'tgan, yo'qotish) ----------
  route('POST', '/api/admin/writeoffs', ['admin'], ({ body, user }) => {
    const qty = num(body.qty, 'Miqdor'); if (qty <= 0) throw bad('Miqdor 0 dan katta bo\'lishi kerak');
    const reason = ['damaged', 'expired', 'lost', 'other'].includes(body.reason) ? body.reason : (() => { throw bad('Sabab noto\'g\'ri'); })();
    return txu(user, async (t) => {
      const p = await t.one('SELECT id,name,stock,cost FROM products WHERE id=? AND active FOR UPDATE', [idArg(body.product_id)]);
      if (!p) throw bad('Mahsulot topilmadi yoki noaktiv');
      if (p.stock < qty) throw new HttpError(409, `"${p.name}" omborda yetarli emas (qoldiq: ${p.stock})`);
      const total = Math.round(qty * p.cost);
      const { id } = await t.one('INSERT INTO writeoffs(product_id,qty,cost,total,reason,note,user_id) VALUES(?,?,?,?,?,?,?) RETURNING id',
        [p.id, qty, p.cost, total, reason, String(body.note || '').slice(0, 300), user.id]);
      await moveStock(t, { product_id: p.id, type: 'writeoff', qty: -qty, writeoff_id: id, user });
      return { id, total };
    });
  });
  route('GET', '/api/admin/writeoffs', ['admin'], ({ query }) => {
    const to = dateArg(query.to, localToday()); const from = dateArg(query.from, addDays(to, -29));
    return db.q(`SELECT w.id,w.qty,w.cost,w.total,w.reason,w.note,w.created_at,p.name product,p.unit,u.name "user" FROM writeoffs w JOIN products p ON p.id=w.product_id JOIN users u ON u.id=w.user_id
      WHERE ${localDate('w.created_at')} BETWEEN ?::date AND ?::date ORDER BY w.id DESC LIMIT 500`, [from, to]);
  });

  // ---------- Moliya: foyda-zarar, pul oqimi, hozirgi holat ----------
  route('GET', '/api/admin/finance', ['admin'], async ({ query }) => {
    const { from, to } = range(query);
    const sales = await db.one(`SELECT COALESCE(SUM(i.line_total) FILTER (WHERE s.kind='sale'),0)::bigint AS gross_sales,
        COALESCE(-SUM(i.line_total) FILTER (WHERE s.kind='return'),0)::bigint AS returns, COALESCE(SUM(i.line_total),0)::bigint AS revenue,
        COALESCE(SUM(i.qty*i.cost),0)::bigint AS cogs FROM sales s JOIN sale_items i ON i.sale_id=s.id WHERE ${LS} BETWEEN ?::date AND ?::date`, [from, to]);
    const discounts = (await db.one(`SELECT COALESCE(SUM(discount),0)::bigint AS d FROM sales s WHERE kind='sale' AND ${LS} BETWEEN ?::date AND ?::date`, [from, to])).d;
    const writeoff = await db.q(`SELECT w.reason, SUM(w.total)::bigint AS total FROM writeoffs w WHERE ${localDate('w.created_at')} BETWEEN ?::date AND ?::date GROUP BY w.reason ORDER BY 2 DESC`, [from, to]);
    const expenses = await db.q(`SELECT o.category, SUM(o.amount)::bigint AS total FROM cash_operations o WHERE o.kind='expense' AND ${localDate('o.created_at')} BETWEEN ?::date AND ?::date GROUP BY o.category ORDER BY 2 DESC`, [from, to]);
    const wo = writeoff.reduce((a, x) => a + x.total, 0), ex = expenses.reduce((a, x) => a + x.total, 0);
    const gross_profit = sales.revenue - sales.cogs;
    const pl = { ...sales, discounts, gross_profit, margin: sales.revenue ? Math.round(gross_profit / sales.revenue * 1000) / 10 : 0,
      writeoff, writeoff_total: wo, expenses, expenses_total: ex, net_profit: gross_profit - wo - ex,
      net_margin: sales.revenue ? Math.round((gross_profit - wo - ex) / sales.revenue * 1000) / 10 : 0 };
    const CL = localDate('c.created_at');
    const opening = (await db.one(`SELECT COALESCE(SUM(amount),0)::bigint AS b FROM cash_ledger c WHERE ${CL} < ?::date`, [from])).b;
    const flows = await db.q(`SELECT kind, SUM(amount)::bigint AS total FROM cash_ledger c WHERE ${CL} BETWEEN ?::date AND ?::date GROUP BY kind`, [from, to]);
    const inflow = flows.filter((f) => f.total > 0).reduce((a, f) => a + f.total, 0), outflow = -flows.filter((f) => f.total < 0).reduce((a, f) => a + f.total, 0);
    const cashflow = { opening, inflow, outflow, net: inflow - outflow, closing: opening + inflow - outflow, flows };
    const accounts = await db.q('SELECT method,balance FROM cash_accounts ORDER BY method');
    const inv = await db.one('SELECT COALESCE(SUM(stock*cost),0)::bigint AS inventory FROM products');
    const recv = await db.one('SELECT COALESCE(SUM(balance),0)::bigint AS receivables FROM customers');
    const sup = await db.one(`SELECT COALESCE(SUM(GREATEST(b,0)),0)::bigint AS payables, COALESCE(SUM(GREATEST(-b,0)),0)::bigint AS advances
      FROM (SELECT SUM(amount) AS b FROM supplier_ledger GROUP BY supplier_id) x`);
    const cash = accounts.reduce((a, x) => a + x.balance, 0);
    const position = { accounts, cash, inventory: inv.inventory, receivables: recv.receivables, advances: sup.advances, payables: sup.payables,
      net_assets: cash + inv.inventory + recv.receivables + sup.advances - sup.payables };
    return { from, to, pl, cashflow, position };
  });

  // ---------- Hujjatlar zanjiri (SAP: document flow) ----------
  route('GET', '/api/admin/document-flow', ['admin'], async ({ query }) => {
    const id = idArg(query.id); const type = query.type;
    const NF = new HttpError(404, 'Hujjat topilmadi');
    // Pul tomoni: kassa daftari va yetkazuvchi daftari yozuvlari (hujjatga FK bo'yicha)
    const money = async (cashCol, supCol, docId) => ({
      cash: cashCol ? await db.q(`SELECT id,method,kind,amount,created_at FROM cash_ledger WHERE ${cashCol}=? ORDER BY id`, [docId]) : [],
      supplier_ledger: supCol ? await db.q(`SELECT l.id,l.kind,l.amount,l.created_at,s.name supplier FROM supplier_ledger l JOIN suppliers s ON s.id=l.supplier_id WHERE l.${supCol}=? ORDER BY l.id`, [docId]) : [] });
    if (type === 'sale') {
      const doc = await db.one(`SELECT s.*,u.name "user",c.name customer FROM sales s JOIN users u ON u.id=s.user_id LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?`, [id]);
      if (!doc) throw NF;
      const lines = await db.q('SELECT i.id,i.orig_item_id,p.name,p.unit,i.qty,i.price,i.line_total FROM sale_items i JOIN products p ON p.id=i.product_id WHERE i.sale_id=? ORDER BY i.id', [id]);
      const moves = await db.q('SELECT m.id,m.type,m.qty,m.created_at,p.name product FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE m.sale_id=? ORDER BY m.id', [id]);
      const led = await db.q('SELECT id,kind,amount,created_at FROM customer_ledger WHERE sale_id=? ORDER BY id', [id]);
      const related = [];
      if (doc.ref_sale_id) related.push({ type: 'sale', id: doc.ref_sale_id, relation: 'Asl sotuv' });
      for (const r of await db.q('SELECT id,total FROM sales WHERE ref_sale_id=? ORDER BY id', [id])) related.push({ type: 'sale', id: r.id, relation: 'Qaytarish', total: r.total });
      return { type, doc, lines, moves, ledger: led, related, ...(await money('sale_id', null, id)) };
    }
    if (type === 'receipt') {
      const doc = await db.one(`SELECT r.*,u.name "user",sp.name supplier FROM receipts r JOIN users u ON u.id=r.user_id LEFT JOIN suppliers sp ON sp.id=r.supplier_id WHERE r.id=?`, [id]);
      if (!doc) throw NF;
      const lines = await db.q('SELECT i.id,p.name,p.unit,i.qty,i.cost,i.line_total FROM receipt_items i JOIN products p ON p.id=i.product_id WHERE i.receipt_id=? ORDER BY i.id', [id]);
      const moves = await db.q('SELECT m.id,m.type,m.qty,m.created_at,p.name product FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE m.receipt_id=? ORDER BY m.id', [id]);
      const related = [];
      if (doc.po_id) related.push({ type: 'po', id: doc.po_id, relation: 'Buyurtma' });
      if (doc.ref_receipt_id) related.push({ type: 'receipt', id: doc.ref_receipt_id, relation: 'Asl kirim' });
      for (const r of await db.q('SELECT id,total FROM receipts WHERE ref_receipt_id=?', [id])) related.push({ type: 'receipt', id: r.id, relation: 'Storno hujjati', total: r.total });
      return { type, doc, lines, moves, ledger: [], related, ...(await money('receipt_id', 'receipt_id', id)) };
    }
    if (type === 'po') {
      const doc = await db.one(`SELECT o.*,u.name "user",sp.name supplier FROM purchase_orders o JOIN users u ON u.id=o.created_by LEFT JOIN suppliers sp ON sp.id=o.supplier_id WHERE o.id=?`, [id]);
      if (!doc) throw NF;
      const lines = await db.q('SELECT i.id,p.name,p.unit,i.qty,i.cost,i.line_total FROM po_items i JOIN products p ON p.id=i.product_id WHERE i.po_id=? ORDER BY i.id', [id]);
      const related = (await db.q('SELECT id,total FROM receipts WHERE po_id=?', [id])).map((r) => ({ type: 'receipt', id: r.id, relation: 'Qabul qilingan kirim', total: r.total }));
      return { type, doc, lines, moves: [], ledger: [], related, cash: [], supplier_ledger: [] };
    }
    if (type === 'payment') {
      const doc = await db.one(`SELECT d.*,u.name "user",c.name customer FROM debt_payments d JOIN users u ON u.id=d.user_id JOIN customers c ON c.id=d.customer_id WHERE d.id=?`, [id]);
      if (!doc) throw NF;
      const led = await db.q('SELECT id,kind,amount,created_at FROM customer_ledger WHERE debt_payment_id=?', [id]);
      return { type, doc, lines: [], moves: [], ledger: led, related: [], ...(await money('debt_payment_id', null, id)) };
    }
    if (type === 'supplier_payment') {
      const doc = await db.one(`SELECT d.*,u.name "user",s.name supplier FROM supplier_payments d JOIN users u ON u.id=d.user_id JOIN suppliers s ON s.id=d.supplier_id WHERE d.id=?`, [id]);
      if (!doc) throw NF;
      return { type, doc, lines: [], moves: [], ledger: [], related: [], ...(await money('supplier_payment_id', 'supplier_payment_id', id)) };
    }
    if (type === 'cash_op') {
      const doc = await db.one(`SELECT d.*,u.name "user" FROM cash_operations d JOIN users u ON u.id=d.user_id WHERE d.id=?`, [id]);
      if (!doc) throw NF;
      return { type, doc, lines: [], moves: [], ledger: [], related: [], ...(await money('cash_operation_id', null, id)) };
    }
    if (type === 'writeoff') {
      const doc = await db.one(`SELECT w.*,p.name product,u.name "user" FROM writeoffs w JOIN products p ON p.id=w.product_id JOIN users u ON u.id=w.user_id WHERE w.id=?`, [id]);
      if (!doc) throw NF;
      const moves = await db.q('SELECT m.id,m.type,m.qty,m.created_at,p.name product FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE m.writeoff_id=?', [id]);
      return { type, doc, lines: [], moves, ledger: [], related: [], cash: [], supplier_ledger: [] };
    }
    throw bad('type: sale | receipt | po | payment | supplier_payment | cash_op | writeoff');
  });

  // Yaxlitlik nazorati: qoldiq/qarz daftarga, hujjat jami qatorlarga, qatorlar ombor harakatlariga teng bo'lishi shart
  const CHECKS = [
    ['stock', 'Mahsulot qoldig\'i = ombor daftari yig\'indisi', `SELECT p.id, p.name, p.stock, COALESCE(SUM(m.qty),0) AS ledger FROM products p LEFT JOIN stock_moves m ON m.product_id=p.id
      GROUP BY p.id HAVING abs(p.stock - COALESCE(SUM(m.qty),0)) > 0.000001`],
    ['balance', 'Mijoz qarzi = mijoz daftari yig\'indisi', `SELECT c.id, c.name, c.balance, COALESCE(SUM(l.amount),0) AS ledger FROM customers c LEFT JOIN customer_ledger l ON l.customer_id=c.id
      GROUP BY c.id HAVING c.balance <> COALESCE(SUM(l.amount),0)`],
    ['sale_total', 'Sotuv jami = qatorlar yig\'indisi (qatorsiz sotuv yo\'q)', `SELECT s.id, s.total, COALESCE(SUM(i.line_total),0) AS lines FROM sales s LEFT JOIN sale_items i ON i.sale_id=s.id
      GROUP BY s.id HAVING s.total <> COALESCE(SUM(i.line_total),0) OR COUNT(i.id)=0`],
    ['sale_moves', 'Sotuv qatorlari = ombor harakatlari', `SELECT COALESCE(i.sale_id,m.sale_id) AS id, COALESCE(i.product_id,m.product_id) AS product_id FROM
      (SELECT sale_id, product_id, SUM(qty) q FROM sale_items GROUP BY 1,2) i FULL JOIN (SELECT sale_id, product_id, SUM(-qty) q FROM stock_moves WHERE sale_id IS NOT NULL GROUP BY 1,2) m
      ON i.sale_id=m.sale_id AND i.product_id=m.product_id WHERE abs(COALESCE(i.q,0)-COALESCE(m.q,0)) > 0.000001`],
    ['receipt_total', 'Kirim jami = qatorlar yig\'indisi (qatorsiz kirim yo\'q)', `SELECT r.id, r.total, COALESCE(SUM(i.line_total),0) AS lines FROM receipts r LEFT JOIN receipt_items i ON i.receipt_id=r.id
      GROUP BY r.id HAVING r.total <> COALESCE(SUM(i.line_total),0) OR COUNT(i.id)=0`],
    ['receipt_moves', 'Kirim qatorlari = ombor harakatlari', `SELECT COALESCE(i.receipt_id,m.receipt_id) AS id, COALESCE(i.product_id,m.product_id) AS product_id FROM
      (SELECT receipt_id, product_id, SUM(qty) q FROM receipt_items GROUP BY 1,2) i FULL JOIN (SELECT receipt_id, product_id, SUM(qty) q FROM stock_moves WHERE receipt_id IS NOT NULL GROUP BY 1,2) m
      ON i.receipt_id=m.receipt_id AND i.product_id=m.product_id WHERE abs(COALESCE(i.q,0)-COALESCE(m.q,0)) > 0.000001`],
    ['po_total', 'Buyurtma jami = qatorlar yig\'indisi', `SELECT o.id, o.total FROM purchase_orders o LEFT JOIN po_items i ON i.po_id=o.id GROUP BY o.id HAVING o.total <> COALESCE(SUM(i.line_total),0) OR COUNT(i.id)=0`],
    ['po_receipt', 'Qabul qilingan buyurtma <-> kirim hujjati', `SELECT o.id FROM purchase_orders o WHERE (o.status='received') <> EXISTS (SELECT 1 FROM receipts r WHERE r.po_id=o.id AND r.kind='receipt')`],
    ['debt_sale', 'Nasiya sotuvlari = mijoz daftari', `SELECT s.id, s.total - s.paid AS debt, COALESCE(SUM(l.amount),0) AS ledger FROM sales s LEFT JOIN customer_ledger l ON l.sale_id=s.id AND l.kind='sale_debt'
      WHERE s.kind='sale' GROUP BY s.id HAVING s.total - s.paid <> COALESCE(SUM(l.amount),0)`],
    ['debt_payment', 'Qarz to\'lovlari = mijoz daftari', `SELECT d.id FROM debt_payments d WHERE NOT EXISTS (SELECT 1 FROM customer_ledger l WHERE l.debt_payment_id=d.id AND l.amount=-d.amount)`],
    ['cash_balance', 'Kassa qoldig\'i = kassa daftari yig\'indisi', `SELECT a.method, a.balance, COALESCE(SUM(l.amount),0) AS ledger FROM cash_accounts a LEFT JOIN cash_ledger l ON l.method=a.method
      GROUP BY a.method, a.balance HAVING a.balance <> COALESCE(SUM(l.amount),0)`],
    ['sale_cash', 'Sotuvga to\'langan pul = kassa daftari', `SELECT s.id, s.paid, COALESCE(SUM(c.amount),0) AS ledger FROM sales s LEFT JOIN cash_ledger c ON c.sale_id=s.id AND c.kind='sale'
      WHERE s.kind='sale' GROUP BY s.id HAVING s.paid <> COALESCE(SUM(c.amount),0)`],
    ['return_cash', 'Qaytarish = qarz + kassa daftari', `SELECT s.id, s.total FROM sales s WHERE s.kind='return' AND -s.total <>
      COALESCE((SELECT -SUM(amount) FROM cash_ledger WHERE sale_id=s.id AND kind='return_refund'),0) + COALESCE((SELECT -SUM(amount) FROM customer_ledger WHERE sale_id=s.id AND kind='return_credit'),0)`],
    ['receipt_money', 'Kirim = yetkazuvchi daftari yoki kassa (naqd xarid)', `SELECT r.id, r.total FROM receipts r WHERE r.kind <> 'opening' AND r.total <>
      CASE WHEN r.supplier_id IS NOT NULL THEN COALESCE((SELECT SUM(amount) FROM supplier_ledger WHERE receipt_id=r.id),0) ELSE COALESCE((SELECT -SUM(amount) FROM cash_ledger WHERE receipt_id=r.id),0) END`],
    ['supplier_payment', 'Yetkazuvchi to\'lovlari = yetkazuvchi va kassa daftari', `SELECT p.id FROM supplier_payments p WHERE
      COALESCE((SELECT SUM(amount) FROM supplier_ledger WHERE supplier_payment_id=p.id),0) <> CASE WHEN p.kind='payment' THEN -p.amount ELSE p.amount END
      OR COALESCE((SELECT SUM(amount) FROM cash_ledger WHERE supplier_payment_id=p.id),0) <> CASE WHEN p.kind='payment' THEN -p.amount ELSE p.amount END`],
    ['cash_operation', 'Kassa operatsiyalari = kassa daftari', `SELECT o.id FROM cash_operations o WHERE COALESCE((SELECT SUM(amount) FROM cash_ledger WHERE cash_operation_id=o.id),0) <>
      CASE WHEN o.kind='owner_deposit' THEN o.amount ELSE -o.amount END`],
    ['writeoff', 'Hisobdan chiqarish = ombor harakati', `SELECT w.id FROM writeoffs w WHERE COALESCE((SELECT SUM(qty) FROM stock_moves WHERE writeoff_id=w.id),0) + w.qty > 0.000001 OR COALESCE((SELECT SUM(qty) FROM stock_moves WHERE writeoff_id=w.id),0) + w.qty < -0.000001`],
    ['debt_payment_cash', 'Mijoz to\'lovlari = kassa daftari', `SELECT d.id FROM debt_payments d WHERE COALESCE((SELECT SUM(amount) FROM cash_ledger WHERE debt_payment_id=d.id),0) <> d.amount`],
    ['returns', 'Qaytarishlar sotilgan miqdordan oshmaydi', `SELECT o.id, o.qty, -SUM(r.qty) AS returned FROM sale_items o JOIN sale_items r ON r.orig_item_id=o.id GROUP BY o.id, o.qty HAVING -SUM(r.qty) > o.qty + 0.000001`],
  ];
  route('GET', '/api/admin/integrity', ['admin'], async () => {
    const checks = [];
    for (const [key, title, sql] of CHECKS) {
      const rows = await db.q(`SELECT * FROM (${sql}) x LIMIT 20`);
      checks.push({ key, title, violations: rows.length, samples: rows.slice(0, 5) });
    }
    return { ok: checks.every((c) => !c.violations), checked_at: new Date().toISOString(), checks };
  });

  // O'zgarishlar tarixi (audit)
  route('GET', '/api/admin/change-log', ['admin'], ({ query }) => {
    const where = []; const args = [];
    if (query.table) { where.push('c.table_name=?'); args.push(String(query.table)); }
    if (query.record_id) { where.push('c.record_id=?'); args.push(idArg(query.record_id)); }
    const lim = query.limit ? Math.min(num(query.limit, 'limit', { int: true, min: 1 }), 500) : 200;
    return db.q(`SELECT c.id,c.table_name,c.record_id,c.action,c.field,c.old_value,c.new_value,c.created_at,u.name "user",
        CASE c.table_name WHEN 'products' THEN (SELECT name FROM products WHERE id=c.record_id)
          WHEN 'customers' THEN (SELECT name FROM customers WHERE id=c.record_id) WHEN 'suppliers' THEN (SELECT name FROM suppliers WHERE id=c.record_id)
          WHEN 'users' THEN (SELECT username FROM users WHERE id=c.record_id) ELSE '#' || c.record_id END label
      FROM change_log c LEFT JOIN users u ON u.id=c.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.id DESC LIMIT ${lim}`, args);
  });

  // ---------- Admin: tahlil ----------
  const range = (q) => {
    const to = dateArg(q.to, localToday());
    const from = dateArg(q.from, addDays(to, -29));
    if (from > to) throw bad('from > to');
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) throw bad('Oraliq 1 yildan oshmasin');
    return { from, to };
  };
  const pf = (q) => (q.product_id ? ['AND i.product_id=?', [idArg(q.product_id)]] : ['', []]);
  const REV = 'i.line_total', PROFIT = 'i.line_total - i.qty * i.cost';

  route('GET', '/api/admin/summary', ['admin'], async ({ query }) => {
    const date = dateArg(query.date, localToday());
    const one = async (d) => {
      const r = await db.one(`SELECT COUNT(DISTINCT s.id) FILTER (WHERE s.kind='sale') orders, COALESCE(SUM(${REV}),0) revenue,
          COALESCE(SUM(${PROFIT}),0) profit, COALESCE(SUM(i.qty),0) items
        FROM sales s JOIN sale_items i ON i.sale_id=s.id WHERE ${LS} = ?::date`, [d]);
      const ex = (await db.one(`SELECT COALESCE(SUM(amount),0)::bigint AS v FROM cash_operations o WHERE kind='expense' AND ${localDate('o.created_at')} = ?::date`, [d])).v;
      const wo = (await db.one(`SELECT COALESCE(SUM(total),0)::bigint AS v FROM writeoffs w WHERE ${localDate('w.created_at')} = ?::date`, [d])).v;
      return { ...r, expenses: ex, writeoffs: wo, net_profit: r.profit - ex - wo }; // profit = yalpi foyda; net_profit = sof foyda
    };
    const [today, yesterday, inventory, debt, cash, sup] = await Promise.all([one(date), one(addDays(date, -1)),
      db.one(`SELECT COUNT(*) products, COALESCE(SUM(stock*cost),0) cost_value, COALESCE(SUM(stock*price),0) retail_value,
        COUNT(*) FILTER (WHERE stock<=min_stock) low FROM products WHERE active`),
      db.one('SELECT COALESCE(SUM(balance),0) total, COUNT(*) FILTER (WHERE balance>0) customers FROM customers'),
      db.q('SELECT method,balance FROM cash_accounts ORDER BY method'),
      db.one(`SELECT COALESCE(SUM(GREATEST(b,0)),0)::bigint AS payables, COALESCE(SUM(GREATEST(-b,0)),0)::bigint AS advances FROM (SELECT SUM(amount) AS b FROM supplier_ledger GROUP BY supplier_id) x`)]);
    return { date, today, yesterday, inventory, debt, cash: { accounts: cash, total: cash.reduce((a, x) => a + x.balance, 0) }, suppliers: sup };
  });
  route('GET', '/api/admin/hourly', ['admin'], async ({ query }) => {
    const { from, to } = range({ from: query.from ?? query.date, to: query.to ?? query.date });
    const [pw, pa] = pf(query);
    const rows = await db.q(`SELECT ${localHour('s.created_at')} AS hour, COUNT(DISTINCT s.id) FILTER (WHERE s.kind='sale') orders,
        SUM(${REV}) revenue, SUM(i.qty) items FROM sales s JOIN sale_items i ON i.sale_id=s.id
      WHERE ${LS} BETWEEN ?::date AND ?::date ${pw} GROUP BY 1`, [from, to, ...pa]);
    const map = new Map(rows.map((r) => [r.hour, r]));
    return { from, to, hours: Array.from({ length: 24 }, (_, h) => map.get(h) || { hour: h, orders: 0, revenue: 0, items: 0 }) };
  });
  route('GET', '/api/admin/daily', ['admin'], async ({ query }) => {
    const { from, to } = range(query);
    const [pw, pa] = pf(query);
    const rows = await db.q(`SELECT to_char(${LS}, 'YYYY-MM-DD') AS day, COUNT(DISTINCT s.id) FILTER (WHERE s.kind='sale') orders, SUM(${REV}) revenue,
        SUM(${PROFIT}) profit, SUM(i.qty) items FROM sales s JOIN sale_items i ON i.sale_id=s.id
      WHERE ${LS} BETWEEN ?::date AND ?::date ${pw} GROUP BY 1`, [from, to, ...pa]);
    const map = new Map(rows.map((r) => [r.day, r]));
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(map.get(d) || { day: d, orders: 0, revenue: 0, profit: 0, items: 0 });
    return { from, to, days };
  });
  route('GET', '/api/admin/top-products', ['admin'], ({ query }) => {
    const { from, to } = range(query);
    const by = query.by === 'profit' ? 'profit' : query.by === 'qty' ? 'qty' : 'revenue';
    return db.q(`SELECT p.id,p.name,p.unit,p.stock, SUM(i.qty) qty, SUM(${REV}) revenue, SUM(${PROFIT}) profit
      FROM sale_items i JOIN sales s ON s.id=i.sale_id JOIN products p ON p.id=i.product_id
      WHERE ${LS} BETWEEN ?::date AND ?::date GROUP BY p.id ORDER BY ${by} DESC LIMIT 50`, [from, to]);
  });
  route('GET', '/api/admin/sellers', ['admin'], ({ query }) => {
    const { from, to } = range(query);
    return db.q(`SELECT u.id,u.name, COUNT(DISTINCT s.id) FILTER (WHERE s.kind='sale') orders, SUM(${REV}) revenue
      FROM sales s JOIN users u ON u.id=s.user_id JOIN sale_items i ON i.sale_id=s.id
      WHERE ${LS} BETWEEN ?::date AND ?::date GROUP BY u.id ORDER BY revenue DESC`, [from, to]);
  });
  route('GET', '/api/admin/stock-moves', ['admin'], ({ query }) => {
    const pid = query.product_id ? idArg(query.product_id) : null;
    return db.q(`SELECT m.*,p.name product,u.name "user" FROM stock_moves m JOIN products p ON p.id=m.product_id
      LEFT JOIN users u ON u.id=m.user_id ${pid ? 'WHERE m.product_id=?' : ''} ORDER BY m.id DESC LIMIT 200`, pid ? [pid] : []);
  });

  // ---------- Admin: kam qolgan mahsulotlarga xarid taklifi ----------
  // Taklif: oxirgi `window` kundagi o'rtacha kunlik sotuv asosida `cover` kunga yetadigan miqdor.
  const buildOffers = async ({ window = 30, cover = 14, lead = 3 } = {}) => {
    const today = localToday();
    const rows = await db.q(`SELECT p.id,p.name,p.unit,p.stock,p.min_stock,p.cost,
        COALESCE((SELECT SUM(i.qty) FROM sale_items i JOIN sales s ON s.id=i.sale_id
                  WHERE i.product_id=p.id AND ${LS} BETWEEN ?::date AND ?::date),0) sold,
        (SELECT r.supplier_id FROM receipt_items ri JOIN receipts r ON r.id=ri.receipt_id
          WHERE ri.product_id=p.id AND r.supplier_id IS NOT NULL ORDER BY r.id DESC LIMIT 1) supplier_id,
        (SELECT COALESCE(SUM(pi.qty),0) FROM po_items pi JOIN purchase_orders o ON o.id=pi.po_id
          WHERE pi.product_id=p.id AND o.status='ordered') on_order
      FROM products p WHERE p.active`, [addDays(today, -window + 1), today]);
    const sup = new Map((await db.q('SELECT id,name,phone FROM suppliers WHERE active')).map((s) => [s.id, s]));
    const out = [];
    for (const r of rows) {
      const daily = Math.max(r.sold, 0) / window;
      const daysLeft = daily > 0 ? r.stock / daily : null;
      const low = r.stock <= r.min_stock || (daysLeft !== null && daysLeft <= lead);
      if (!low) continue;
      const target = Math.max(r.min_stock * 2, daily * cover);
      const need = Math.ceil(Math.max(target - r.stock - r.on_order, 0));
      if (need <= 0) continue; // allaqachon buyurtma qilingan
      const s = sup.get(r.supplier_id);
      out.push({ product_id: r.id, name: r.name, unit: r.unit, stock: r.stock, min_stock: r.min_stock,
        avg_daily: Math.round(daily * 100) / 100, days_left: daysLeft === null ? null : Math.round(daysLeft * 10) / 10,
        on_order: r.on_order, suggested_qty: need, cost: r.cost, est_total: Math.round(need * r.cost),
        urgency: r.stock <= 0 ? 'out' : (daysLeft !== null && daysLeft <= 1) || r.stock <= r.min_stock / 2 ? 'critical' : 'low',
        supplier_id: s?.id ?? null, supplier: s?.name ?? null });
    }
    const rank = { out: 0, critical: 1, low: 2 };
    return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.days_left ?? 1e9) - (b.days_left ?? 1e9));
  };
  route('GET', '/api/admin/offers', ['admin'], ({ query }) => buildOffers({
    window: query.window ? num(query.window, 'window', { int: true, min: 1 }) : 30,
    cover: query.cover ? num(query.cover, 'cover', { int: true, min: 1 }) : 14,
    lead: query.lead ? num(query.lead, 'lead', { min: 0 }) : 3 }));

  route('POST', '/api/admin/purchase-orders', ['admin'], ({ body, user }) => {
    const items = lines(body.items, { cost: true });
    if (items.some((it) => !(it.cost > 0))) throw bad('Buyurtma narxini kiriting (0 bo\'lmasin)');
    const supplier_id = body.supplier_id ? idArg(body.supplier_id) : null;
    return txu(user, async (t) => {
      if (supplier_id && !(await t.one('SELECT 1 x FROM suppliers WHERE id=? AND active', [supplier_id]))) throw bad('Yetkazib beruvchi topilmadi yoki noaktiv');
      let total = 0;
      for (const it of items) {
        if (!(await t.one('SELECT 1 x FROM products WHERE id=?', [it.product_id]))) throw bad('Mahsulot topilmadi');
        total += Math.round(it.qty * it.cost);
      }
      const { id } = await t.one('INSERT INTO purchase_orders(supplier_id,created_by,total) VALUES(?,?,?) RETURNING id', [supplier_id, user.id, total]);
      for (const it of items) await t.run('INSERT INTO po_items(po_id,product_id,qty,cost,line_total) VALUES(?,?,?,?,?)', [id, it.product_id, it.qty, it.cost, Math.round(it.qty * it.cost)]);
      return { id, total };
    });
  });
  route('GET', '/api/admin/purchase-orders', ['admin'], async () => {
    const orders = await db.q(`SELECT o.*,s.name supplier,s.phone supplier_phone FROM purchase_orders o LEFT JOIN suppliers s ON s.id=o.supplier_id ORDER BY o.id DESC LIMIT 100`);
    if (!orders.length) return [];
    const items = await db.q(`SELECT i.po_id,i.product_id,p.name,p.unit,i.qty,i.cost FROM po_items i JOIN products p ON p.id=i.product_id
      WHERE i.po_id = ANY(?::bigint[]) ORDER BY i.id`, [orders.map((o) => o.id)]);
    return orders.map((o) => ({ ...o, items: items.filter((i) => i.po_id === o.id) }));
  });
  route('POST', '/api/admin/purchase-orders/:id/receive', ['admin'], ({ params, user }) => txu(user, async (t) => {
    const o = await t.one('SELECT * FROM purchase_orders WHERE id=? FOR UPDATE', [idArg(params.id)]);
    if (!o) throw new HttpError(404, 'Buyurtma topilmadi');
    if (o.status !== 'ordered') throw new HttpError(409, 'Buyurtma allaqachon yopilgan');
    const items = await t.q('SELECT product_id,qty,cost FROM po_items WHERE po_id=? ORDER BY product_id', [o.id]);
    const r = await receiveStock(t, { items, supplier_id: o.supplier_id, note: `Buyurtma #${o.id}`, user, source: 'purchase', po_id: o.id });
    await t.run("UPDATE purchase_orders SET status='received', closed_at=now() WHERE id=?", [o.id]);
    return r;
  }));
  route('POST', '/api/admin/purchase-orders/:id/cancel', ['admin'], async ({ params }) => {
    const n = await db.run("UPDATE purchase_orders SET status='cancelled', closed_at=now() WHERE id=? AND status='ordered'", [idArg(params.id)]);
    if (!n) throw new HttpError(409, 'Buyurtmani bekor qilib bo\'lmaydi');
    return { ok: true };
  });

  // ---------- Admin: foydalanuvchilar ----------
  route('GET', '/api/admin/users', ['admin'], () => db.q('SELECT id,username,name,role,active FROM users ORDER BY id'));
  route('POST', '/api/admin/users', ['admin'], async ({ body, user }) => {
    const role = body.role === 'admin' ? 'admin' : 'seller';
    const pw = str(body.password, 'Parol', 100);
    if (pw.length < 6) throw bad('Parol kamida 6 belgi');
    try {
      return await txu(user, (t) => t.one('INSERT INTO users(username,name,role,password_hash) VALUES(?,?,?,?) RETURNING id',
        [str(body.username, 'Login', 40), str(body.name, 'Ism', 80), role, hashPassword(pw)]));
    } catch (e) { if (isUnique(e)) throw bad('Bunday login band'); throw e; }
  });
  route('PUT', '/api/admin/users/:id', ['admin'], ({ params, body, user }) => txu(user, async (db) => {
    const id = idArg(params.id);
    if (id === user.id && body.active === false) throw bad('O\'zingizni o\'chira olmaysiz');
    if (body.password) {
      if (String(body.password).length < 6) throw bad('Parol kamida 6 belgi');
      await db.run('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(String(body.password)), id]);
    }
    if (typeof body.active === 'boolean') {
      if (!body.active) {
        const left = await db.one("SELECT COUNT(*)::int c FROM users WHERE role='admin' AND active AND id<>?", [id]);
        const target = await db.one('SELECT role FROM users WHERE id=?', [id]);
        if (target?.role === 'admin' && !left.c) throw bad('Oxirgi aktiv adminni noaktiv qilib bo\'lmaydi');
      }
      await db.run('UPDATE users SET active=? WHERE id=?', [body.active, id]);
      if (!body.active) await db.run('UPDATE sessions SET revoked=TRUE WHERE user_id=?', [id]);
    }
    return { ok: true };
  }));

  // ---------- HTTP ----------
  const cookie = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
  const readBody = async (req) => {
    if (req.method === 'GET') return {};
    // Vercel req.body ni o'zi parse qiladi (oqim iste'mol qilingan bo'lishi mumkin)
    const pre = req.body;
    if (pre !== undefined) {
      if (Buffer.isBuffer(pre)) { try { return pre.length ? JSON.parse(pre) : {}; } catch { throw bad('JSON xato'); } }
      if (typeof pre === 'string') { try { return pre ? JSON.parse(pre) : {}; } catch { throw bad('JSON xato'); } }
      return pre && typeof pre === 'object' ? pre : {};
    }
    let n = 0; const chunks = [];
    for await (const c of req) { n += c.length; if (n > 1e6) throw new HttpError(413, 'So\'rov juda katta'); chunks.push(c); }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { throw bad('JSON xato'); }
  };
  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const sessionUser = (req) => {
    const t = cookie(req).sid;
    if (!t) return null;
    return db.one(`SELECT u.id,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token=? AND NOT s.revoked AND u.active AND s.created_at > now() - interval '12 hours'`, [t]);
  };
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        await ensureReady(db);
        const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
        if (!r) throw new HttpError(404, 'Topilmadi');
        const user = r.roles ? await sessionUser(req) : null;
        if (r.roles && (!user || (r.roles.length && !r.roles.includes(user.role)))) {
          throw new HttpError(user ? 403 : 401, user ? 'Ruxsat yo\'q' : 'Kirish talab qilinadi');
        }
        if (req.method !== 'GET' && r.roles && req.headers['x-requested-with'] !== 'erp') throw new HttpError(403, 'CSRF');
        const m = url.pathname.match(r.re);
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const out = await r.handler({ req, res, user, params, body: await readBody(req), query: Object.fromEntries(url.searchParams),
          ip: clientIp(req), secure: req.headers['x-forwarded-proto'] === 'https' });
        return send(res, 200, out);
      }
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^([/\\])+/, '');
      if (rel.includes('..')) throw new HttpError(404, 'Topilmadi');
      const data = await readFile(join(PUBLIC, rel)).catch(() => { throw new HttpError(404, 'Topilmadi'); });
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, 'Permissions-Policy': 'camera=(self)' });
      res.end(data);
    } catch (e) {
      let status = e.status || 500, msg = e instanceof HttpError ? e.message : 'Server xatosi';
      if (!(e instanceof HttpError)) {
        if (typeof e?.code === 'string' && e.code.startsWith('23')) { // baza yaxlitlik qoidasi buzildi
          status = 409;
          msg = e.code === '23000' ? e.message : /chk_stock_nonneg/.test(e.constraint || e.message) ? 'Omborda yetarli emas'
            : /chk_cash_nonneg/.test(e.constraint || e.message) ? 'Kassada mablag\' yetarli emas'
            : /chk_balance_nonneg/.test(e.constraint || e.message) ? 'Qarz summasi noto\'g\'ri' : e.code === '23505' ? 'Takroriy yozuv'
            : e.code === '23503' ? 'Bog\'liq hujjat/ma\'lumot topilmadi' : 'Ma\'lumot yaxlitligi qoidasi buzildi';
        } else console.error(e);
      }
      send(res, status, { error: msg });
    }
  };
}

export const createApp = (db) => createServer(createHandler(db));
