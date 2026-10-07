import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, localDate, localHour, TZ, ensureReady } from './db.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
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
    await db.run('DELETE FROM login_attempts WHERE ip=?', [ip]);
    await db.run("DELETE FROM sessions WHERE created_at < now() - interval '12 hours'");
    const token = randomBytes(32).toString('hex');
    await db.run('INSERT INTO sessions(token,user_id) VALUES(?,?)', [token, u.id]);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}${secure ? '; Secure' : ''}`);
    return { id: u.id, name: u.name, role: u.role };
  });
  route('POST', '/api/logout', [], async ({ req, res }) => {
    await db.run('DELETE FROM sessions WHERE token=?', [cookie(req).sid || '']);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return { ok: true };
  });
  route('GET', '/api/me', [], ({ user }) => user);

  // ---------- Mahsulotlar / ombor ----------
  route('GET', '/api/products', ['admin', 'seller'], ({ user }) => {
    const cols = user.role === 'admin' ? '*' : 'id,sku,name,category,unit,price,stock,min_stock,active';
    return db.q(`SELECT ${cols} FROM products WHERE active ORDER BY name`);
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
      return await db.tx(async (t) => {
        const { id } = await t.one(`INSERT INTO products(sku,name,category,unit,price,cost,stock,min_stock)
          VALUES(?,?,?,?,?,?,?,?) RETURNING id`, [p.sku, p.name, p.category, p.unit, p.price, p.cost, stock, p.min_stock]);
        if (stock) await t.run('INSERT INTO stock_moves(product_id,type,qty,user_id) VALUES(?,?,?,?)', [id, 'initial', stock, user.id]);
        return { id };
      });
    } catch (e) { if (isUnique(e)) throw bad('Bu SKU band'); throw e; }
  });
  route('PUT', '/api/products/:id', ['admin'], async ({ body, params }) => {
    const p = productBody(body);
    try {
      const n = await db.run(`UPDATE products SET sku=?,name=?,category=?,unit=?,price=?,cost=?,min_stock=?,active=? WHERE id=?`,
        [p.sku, p.name, p.category, p.unit, p.price, p.cost, p.min_stock, body.active !== false, idArg(params.id)]);
      if (!n) throw new HttpError(404, 'Mahsulot topilmadi');
    } catch (e) { if (isUnique(e)) throw bad('Bu SKU band'); throw e; }
    return { ok: true };
  });

  // ---------- Yetkazib beruvchilar va mijozlar ----------
  route('GET', '/api/suppliers', ['admin', 'seller'], () => db.q('SELECT * FROM suppliers ORDER BY name'));
  route('POST', '/api/suppliers', ['admin', 'seller'], async ({ body }) => {
    try {
      return await db.one('INSERT INTO suppliers(name,phone) VALUES(?,?) RETURNING id', [str(body.name, 'Nomi'), String(body.phone || '').slice(0, 40)]);
    } catch (e) { if (isUnique(e)) throw bad('Bunday yetkazib beruvchi bor'); throw e; }
  });
  route('GET', '/api/customers', ['admin', 'seller'], () => db.q('SELECT id,name,phone,balance FROM customers ORDER BY name'));
  route('POST', '/api/customers', ['admin', 'seller'], ({ body }) =>
    db.one('INSERT INTO customers(name,phone) VALUES(?,?) RETURNING id', [str(body.name, 'Ism', 80), String(body.phone || '').slice(0, 40)]));
  route('POST', '/api/customers/:id/payments', ['admin', 'seller'], ({ body, params, user }) => {
    const amount = num(body.amount, 'Summa', { int: true, min: 1 });
    return db.tx(async (t) => {
      const c = await t.one('UPDATE customers SET balance = balance - ? WHERE id=? AND balance >= ? RETURNING balance', [amount, idArg(params.id), amount]);
      if (!c) throw new HttpError(409, 'Summa mijoz qarzidan oshib ketdi yoki mijoz topilmadi');
      await t.run('INSERT INTO debt_payments(customer_id,user_id,amount) VALUES(?,?,?)', [params.id, user.id, amount]);
      return { balance: c.balance };
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
    return db.tx(async (t) => {
      const rows = [];
      let subtotal = 0;
      for (const it of items) {
        const p = await t.one('SELECT id,name,price,cost FROM products WHERE id=? AND active', [it.product_id]);
        if (!p) throw bad('Mahsulot topilmadi');
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
      if (customer_id && !(await t.one('SELECT 1 x FROM customers WHERE id=?', [customer_id]))) throw bad('Mijoz topilmadi');

      const { id: sid } = await t.one('INSERT INTO sales(user_id,customer_id,discount,total,paid,method) VALUES(?,?,?,?,?,?) RETURNING id',
        [user.id, customer_id, discount, total, paid, method]);
      let left = total;
      for (const [i, r] of rows.entries()) {
        // chegirma qatorlarga proporsional taqsimlanadi, qoldiq oxirgi qatorga
        const line = i === rows.length - 1 ? left : (subtotal ? Math.round(r.gross * total / subtotal) : 0);
        left -= line;
        const upd = await t.one('UPDATE products SET stock = stock - ? WHERE id=? AND stock >= ? RETURNING stock', [r.qty, r.p.id, r.qty]);
        if (!upd) throw new HttpError(409, `"${r.p.name}" omborda yetarli emas`);
        await t.run('INSERT INTO sale_items(sale_id,product_id,qty,price,line_total,cost) VALUES(?,?,?,?,?,?)', [sid, r.p.id, r.qty, r.p.price, line, r.p.cost]);
        await t.run('INSERT INTO stock_moves(product_id,type,qty,ref_id,user_id) VALUES(?,?,?,?,?)', [r.p.id, 'sale', -r.qty, sid, user.id]);
      }
      if (paid < total) await t.run('UPDATE customers SET balance = balance + ? WHERE id=?', [total - paid, customer_id]);
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
    return db.tx(async (t) => {
      const sale = await t.one("SELECT id,customer_id FROM sales WHERE id=? AND kind='sale' FOR UPDATE", [sale_id]);
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
      const { id } = await t.one("INSERT INTO sales(user_id,kind,ref_sale_id,customer_id,total,paid,method) VALUES(?,'return',?,?,?,0,'cash') RETURNING id",
        [user.id, sale_id, sale.customer_id, -total]);
      for (const r of picked) {
        await t.run('INSERT INTO sale_items(sale_id,product_id,orig_item_id,qty,price,line_total,cost) VALUES(?,?,?,?,?,?,?)',
          [id, r.it.product_id, r.it.id, -r.qty, r.it.price, -r.amount, r.it.cost]);
        await t.run('UPDATE products SET stock = stock + ? WHERE id=?', [r.qty, r.it.product_id]);
        await t.run('INSERT INTO stock_moves(product_id,type,qty,ref_id,user_id) VALUES(?,?,?,?,?)', [r.it.product_id, 'return', r.qty, id, user.id]);
      }
      let toDebtAmt = 0;
      if (toDebt) { // qaytarilgan summa avval mijoz qarzini kamaytiradi, ortig'i naqd qaytariladi
        const c = await t.one('SELECT balance FROM customers WHERE id=? FOR UPDATE', [sale.customer_id]);
        toDebtAmt = Math.min(total, c.balance);
        if (toDebtAmt) await t.run('UPDATE customers SET balance = balance - ? WHERE id=?', [toDebtAmt, sale.customer_id]);
      }
      return { id, total, to_debt: toDebtAmt, cash_refund: total - toDebtAmt };
    });
  });

  // ---------- Kirim ----------
  const receiveStock = async (t, { items, supplier_id, note, user, source }) => {
    const { id: rid } = await t.one('INSERT INTO receipts(user_id,supplier_id,note) VALUES(?,?,?) RETURNING id', [user.id, supplier_id ?? null, note]);
    let total = 0;
    for (const it of items) {
      const p = await t.one('SELECT id FROM products WHERE id=? AND active', [it.product_id]);
      if (!p) throw bad('Mahsulot topilmadi');
      total += Math.round(it.cost * it.qty);
      await t.run('INSERT INTO receipt_items(receipt_id,product_id,qty,cost) VALUES(?,?,?,?)', [rid, it.product_id, it.qty, it.cost]);
      await t.run('UPDATE products SET stock=stock+?, cost=? WHERE id=?', [it.qty, it.cost, it.product_id]);
      await t.run('INSERT INTO stock_moves(product_id,type,qty,ref_id,user_id) VALUES(?,?,?,?,?)', [it.product_id, source, it.qty, rid, user.id]);
    }
    await t.run('UPDATE receipts SET total=? WHERE id=?', [total, rid]);
    return { id: rid, total };
  };
  route('POST', '/api/receipts', ['admin', 'seller'], async ({ body, user }) => {
    const items = lines(body.items, { cost: true });
    const supplier_id = body.supplier_id ? idArg(body.supplier_id) : null;
    if (supplier_id && !(await db.one('SELECT 1 x FROM suppliers WHERE id=?', [supplier_id]))) throw bad('Yetkazib beruvchi topilmadi');
    return db.tx((t) => receiveStock(t, { items, supplier_id, note: String(body.note || '').slice(0, 300), user, source: 'receipt' }));
  });
  route('GET', '/api/receipts', ['admin', 'seller'], ({ query, user }) => {
    const date = dateArg(query.date, localToday());
    const own = user.role === 'seller' ? 'AND r.user_id=?' : '';
    return db.q(`SELECT r.id,r.total,r.note,r.created_at,u.name "user",sp.name supplier,
        (SELECT string_agg(p.name || ' ×' || i.qty::text, ', ' ORDER BY i.id) FROM receipt_items i JOIN products p ON p.id=i.product_id WHERE i.receipt_id=r.id) items
      FROM receipts r JOIN users u ON u.id=r.user_id LEFT JOIN suppliers sp ON sp.id=r.supplier_id
      WHERE ${localDate('r.created_at')} = ?::date ${own} ORDER BY r.id DESC LIMIT 500`, user.role === 'seller' ? [date, user.id] : [date]);
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
    const one = (d) => db.one(`SELECT COUNT(DISTINCT s.id) FILTER (WHERE s.kind='sale') orders, COALESCE(SUM(${REV}),0) revenue,
        COALESCE(SUM(${PROFIT}),0) profit, COALESCE(SUM(i.qty),0) items
      FROM sales s JOIN sale_items i ON i.sale_id=s.id WHERE ${LS} = ?::date`, [d]);
    const [today, yesterday, inventory, debt] = await Promise.all([one(date), one(addDays(date, -1)),
      db.one(`SELECT COUNT(*) products, COALESCE(SUM(stock*cost),0) cost_value, COALESCE(SUM(stock*price),0) retail_value,
        COUNT(*) FILTER (WHERE stock<=min_stock) low FROM products WHERE active`),
      db.one('SELECT COALESCE(SUM(balance),0) total, COUNT(*) FILTER (WHERE balance>0) customers FROM customers')]);
    return { date, today, yesterday, inventory, debt };
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
    const sup = new Map((await db.q('SELECT id,name,phone FROM suppliers')).map((s) => [s.id, s]));
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
    const supplier_id = body.supplier_id ? idArg(body.supplier_id) : null;
    return db.tx(async (t) => {
      let total = 0;
      for (const it of items) {
        if (!(await t.one('SELECT 1 x FROM products WHERE id=?', [it.product_id]))) throw bad('Mahsulot topilmadi');
        total += Math.round(it.qty * it.cost);
      }
      const { id } = await t.one('INSERT INTO purchase_orders(supplier_id,created_by,total) VALUES(?,?,?) RETURNING id', [supplier_id, user.id, total]);
      for (const it of items) await t.run('INSERT INTO po_items(po_id,product_id,qty,cost) VALUES(?,?,?,?)', [id, it.product_id, it.qty, it.cost]);
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
  route('POST', '/api/admin/purchase-orders/:id/receive', ['admin'], ({ params, user }) => db.tx(async (t) => {
    const o = await t.one('SELECT * FROM purchase_orders WHERE id=? FOR UPDATE', [idArg(params.id)]);
    if (!o) throw new HttpError(404, 'Buyurtma topilmadi');
    if (o.status !== 'ordered') throw new HttpError(409, 'Buyurtma allaqachon yopilgan');
    const items = await t.q('SELECT product_id,qty,cost FROM po_items WHERE po_id=? ORDER BY product_id', [o.id]);
    const r = await receiveStock(t, { items, supplier_id: o.supplier_id, note: `Buyurtma #${o.id}`, user, source: 'purchase' });
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
  route('POST', '/api/admin/users', ['admin'], async ({ body }) => {
    const role = body.role === 'admin' ? 'admin' : 'seller';
    const pw = str(body.password, 'Parol', 100);
    if (pw.length < 6) throw bad('Parol kamida 6 belgi');
    try {
      return await db.one('INSERT INTO users(username,name,role,password_hash) VALUES(?,?,?,?) RETURNING id',
        [str(body.username, 'Login', 40), str(body.name, 'Ism', 80), role, hashPassword(pw)]);
    } catch (e) { if (isUnique(e)) throw bad('Bunday login band'); throw e; }
  });
  route('PUT', '/api/admin/users/:id', ['admin'], async ({ params, body, user }) => {
    const id = idArg(params.id);
    if (id === user.id && body.active === false) throw bad('O\'zingizni o\'chira olmaysiz');
    if (body.password) {
      if (String(body.password).length < 6) throw bad('Parol kamida 6 belgi');
      await db.run('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(String(body.password)), id]);
    }
    if (typeof body.active === 'boolean') {
      await db.run('UPDATE users SET active=? WHERE id=?', [body.active, id]);
      if (!body.active) await db.run('DELETE FROM sessions WHERE user_id=?', [id]);
    }
    return { ok: true };
  });

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
      WHERE s.token=? AND u.active AND s.created_at > now() - interval '12 hours'`, [t]);
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
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP });
      res.end(data);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Server xatosi' });
    }
  };
}

export const createApp = (db) => createServer(createHandler(db));
