import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx, hashPassword, verifyPassword, localExpr, TZ_HOURS } from './db.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const num = (v, name, { min = 0, int = false } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw bad(`${name} noto'g'ri`);
  return n;
};
const str = (v, name, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${name} noto'g'ri`);
  return v.trim();
};
export const localToday = () => new Date(Date.now() + TZ_HOURS * 3600e3).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const dateArg = (s, def) => (s == null ? def : isDate(s) ? s : (() => { throw bad('sana noto\'g\'ri (YYYY-MM-DD)'); })());
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export function createApp(db) {
  const L = localExpr('s.created_at');
  const routes = [];
  const route = (method, path, roles, handler) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, roles, handler });
  };

  // ---------- Auth ----------
  const attempts = new Map();
  route('POST', '/api/login', null, ({ body, ip, res }) => {
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) throw new HttpError(429, 'Juda ko\'p urinish, keyinroq qayta urining');
    const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(body.username || ''));
    if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) {
      attempts.set(ip, { ...a, n: a.n + 1 });
      throw new HttpError(401, 'Login yoki parol xato');
    }
    attempts.delete(ip);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').run(token, u.id);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
    return { id: u.id, name: u.name, role: u.role };
  });
  route('POST', '/api/logout', [], ({ req, res }) => {
    db.prepare('DELETE FROM sessions WHERE token=?').run(cookie(req).sid || '');
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return { ok: true };
  });
  route('GET', '/api/me', [], ({ user }) => user);

  // ---------- Mahsulotlar / ombor ----------
  route('GET', '/api/products', ['admin', 'seller'], ({ user }) => {
    const cols = user.role === 'admin' ? '*' : 'id,sku,name,category,unit,price,stock,min_stock,active';
    return db.prepare(`SELECT ${cols} FROM products WHERE active=1 ORDER BY name`).all();
  });
  const productBody = (b) => ({
    sku: b.sku ? str(b.sku, 'SKU', 50) : null, name: str(b.name, 'Nomi'),
    category: String(b.category || '').slice(0, 80), unit: str(b.unit || 'dona', 'Birlik', 20),
    price: num(b.price, 'Narx', { int: true }), cost: num(b.cost ?? 0, 'Tannarx', { int: true }),
    min_stock: num(b.min_stock ?? 0, 'Minimal qoldiq'),
  });
  route('POST', '/api/products', ['admin'], ({ body, user }) => {
    const p = productBody(body);
    const stock = num(body.stock ?? 0, 'Qoldiq');
    return tx(db, () => {
      const id = Number(db.prepare(`INSERT INTO products(sku,name,category,unit,price,cost,stock,min_stock)
        VALUES(?,?,?,?,?,?,?,?)`).run(p.sku, p.name, p.category, p.unit, p.price, p.cost, stock, p.min_stock).lastInsertRowid);
      if (stock) db.prepare('INSERT INTO stock_moves(product_id,type,qty,user_id) VALUES(?,?,?,?)').run(id, 'initial', stock, user.id);
      return { id };
    });
  });
  route('PUT', '/api/products/:id', ['admin'], ({ body, params }) => {
    const p = productBody(body);
    const r = db.prepare(`UPDATE products SET sku=?,name=?,category=?,unit=?,price=?,cost=?,min_stock=?,active=? WHERE id=?`)
      .run(p.sku, p.name, p.category, p.unit, p.price, p.cost, p.min_stock, body.active === false ? 0 : 1, params.id);
    if (!r.changes) throw new HttpError(404, 'Mahsulot topilmadi');
    return { ok: true };
  });

  // ---------- Yetkazib beruvchilar ----------
  route('GET', '/api/suppliers', ['admin', 'seller'], () => db.prepare('SELECT * FROM suppliers ORDER BY name').all());
  route('POST', '/api/suppliers', ['admin', 'seller'], ({ body }) => {
    try {
      return { id: Number(db.prepare('INSERT INTO suppliers(name,phone) VALUES(?,?)')
        .run(str(body.name, 'Nomi'), String(body.phone || '').slice(0, 40)).lastInsertRowid) };
    } catch (e) { if (/UNIQUE/.test(e.message)) throw bad('Bunday yetkazib beruvchi bor'); throw e; }
  });

  // ---------- Sotuv ----------
  const lines = (arr, { price = false, cost = false } = {}) => {
    if (!Array.isArray(arr) || !arr.length || arr.length > 200) throw bad('Mahsulotlar ro\'yxati bo\'sh');
    const seen = new Set();
    return arr.map((l) => {
      const product_id = num(l.product_id, 'Mahsulot', { int: true, min: 1 });
      if (seen.has(product_id)) throw bad('Bir mahsulot ikki marta kiritilgan');
      seen.add(product_id);
      const qty = num(l.qty, 'Miqdor');
      if (qty <= 0) throw bad('Miqdor 0 dan katta bo\'lishi kerak');
      return { product_id, qty, price: price ? num(l.price, 'Narx', { int: true }) : undefined,
        cost: cost ? num(l.cost, 'Tannarx', { int: true }) : undefined };
    });
  };
  route('POST', '/api/sales', ['admin', 'seller'], ({ body, user }) => {
    const items = lines(body.items);
    const method = ['cash', 'card', 'transfer'].includes(body.method) ? body.method : 'cash';
    return tx(db, () => {
      let total = 0;
      const prepared = items.map((it) => {
        const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(it.product_id);
        if (!p) throw bad('Mahsulot topilmadi');
        if (p.stock < it.qty) throw new HttpError(409, `"${p.name}" omborda yetarli emas (qoldiq: ${p.stock})`);
        total += Math.round(p.price * it.qty);
        return { p, qty: it.qty };
      });
      const sid = Number(db.prepare('INSERT INTO sales(user_id,total,method) VALUES(?,?,?)').run(user.id, total, method).lastInsertRowid);
      for (const { p, qty } of prepared) {
        db.prepare('INSERT INTO sale_items(sale_id,product_id,qty,price,cost) VALUES(?,?,?,?,?)').run(sid, p.id, qty, p.price, p.cost);
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty, p.id);
        db.prepare('INSERT INTO stock_moves(product_id,type,qty,ref_id,user_id) VALUES(?,?,?,?,?)').run(p.id, 'sale', -qty, sid, user.id);
      }
      return { id: sid, total };
    });
  });
  route('GET', '/api/sales', ['admin', 'seller'], ({ query, user }) => {
    const date = dateArg(query.date, localToday());
    const own = user.role === 'seller' ? 'AND s.user_id=?' : '';
    const args = user.role === 'seller' ? [date, user.id] : [date];
    return db.prepare(`SELECT s.id,s.total,s.method,s.created_at,u.name seller,
        (SELECT group_concat(p.name||' ×'||i.qty, ', ') FROM sale_items i JOIN products p ON p.id=i.product_id WHERE i.sale_id=s.id) items
      FROM sales s JOIN users u ON u.id=s.user_id WHERE date(${L})=? ${own} ORDER BY s.id DESC LIMIT 500`).all(...args);
  });

  // ---------- Kirim ----------
  const receiveStock = ({ items, supplier_id, note, user, source }) => {
    let total = 0;
    const rid = Number(db.prepare('INSERT INTO receipts(user_id,supplier_id,note,total) VALUES(?,?,?,0)')
      .run(user.id, supplier_id ?? null, note, ).lastInsertRowid);
    for (const it of items) {
      const p = db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(it.product_id);
      if (!p) throw bad('Mahsulot topilmadi');
      total += Math.round(it.cost * it.qty);
      db.prepare('INSERT INTO receipt_items(receipt_id,product_id,qty,cost) VALUES(?,?,?,?)').run(rid, it.product_id, it.qty, it.cost);
      db.prepare('UPDATE products SET stock=stock+?, cost=? WHERE id=?').run(it.qty, it.cost, it.product_id);
      db.prepare('INSERT INTO stock_moves(product_id,type,qty,ref_id,user_id) VALUES(?,?,?,?,?)').run(it.product_id, source, it.qty, rid, user.id);
    }
    db.prepare('UPDATE receipts SET total=? WHERE id=?').run(total, rid);
    return { id: rid, total };
  };
  route('POST', '/api/receipts', ['admin', 'seller'], ({ body, user }) => {
    const items = lines(body.items, { cost: true });
    const supplier_id = body.supplier_id ? num(body.supplier_id, 'Yetkazib beruvchi', { int: true, min: 1 }) : null;
    if (supplier_id && !db.prepare('SELECT 1 FROM suppliers WHERE id=?').get(supplier_id)) throw bad('Yetkazib beruvchi topilmadi');
    return tx(db, () => receiveStock({ items, supplier_id, note: String(body.note || '').slice(0, 300), user, source: 'receipt' }));
  });
  route('GET', '/api/receipts', ['admin', 'seller'], ({ query, user }) => {
    const date = dateArg(query.date, localToday());
    const own = user.role === 'seller' ? 'AND r.user_id=?' : '';
    const args = user.role === 'seller' ? [date, user.id] : [date];
    return db.prepare(`SELECT r.id,r.total,r.note,r.created_at,u.name user,sp.name supplier,
        (SELECT group_concat(p.name||' ×'||i.qty, ', ') FROM receipt_items i JOIN products p ON p.id=i.product_id WHERE i.receipt_id=r.id) items
      FROM receipts r JOIN users u ON u.id=r.user_id LEFT JOIN suppliers sp ON sp.id=r.supplier_id
      WHERE date(${localExpr('r.created_at')})=? ${own} ORDER BY r.id DESC LIMIT 500`).all(...args);
  });

  // ---------- Admin: tahlil ----------
  const range = (q) => {
    const to = dateArg(q.to, localToday());
    const from = dateArg(q.from, addDays(to, -29));
    if (from > to) throw bad('from > to');
    return { from, to };
  };
  const pf = (q) => (q.product_id ? ['AND i.product_id=?', num(q.product_id, 'product_id', { int: true })] : ['', null]);

  route('GET', '/api/admin/summary', ['admin'], ({ query }) => {
    const date = dateArg(query.date, localToday());
    const one = (d) => db.prepare(`SELECT COUNT(DISTINCT s.id) orders, COALESCE(SUM(i.qty*i.price),0) revenue,
        COALESCE(SUM(i.qty*(i.price-i.cost)),0) profit, COALESCE(SUM(i.qty),0) items
      FROM sales s JOIN sale_items i ON i.sale_id=s.id WHERE date(${L})=?`).get(d);
    const today = one(date), prev = one(addDays(date, -1));
    const inv = db.prepare(`SELECT COUNT(*) products, COALESCE(SUM(stock*cost),0) cost_value, COALESCE(SUM(stock*price),0) retail_value,
        SUM(stock<=min_stock) low FROM products WHERE active=1`).get();
    return { date, today, yesterday: prev, inventory: inv };
  });
  route('GET', '/api/admin/hourly', ['admin'], ({ query }) => {
    const { from, to } = range({ from: query.from ?? query.date, to: query.to ?? query.date });
    const [pw, pa] = pf(query);
    const rows = db.prepare(`SELECT CAST(strftime('%H',${L}) AS INTEGER) hour, COUNT(DISTINCT s.id) orders,
        SUM(i.qty*i.price) revenue, SUM(i.qty) items FROM sales s JOIN sale_items i ON i.sale_id=s.id
      WHERE date(${L}) BETWEEN ? AND ? ${pw} GROUP BY hour`).all(...[from, to, pa].filter((x) => x !== null));
    const map = new Map(rows.map((r) => [r.hour, r]));
    return { from, to, hours: Array.from({ length: 24 }, (_, h) => map.get(h) || { hour: h, orders: 0, revenue: 0, items: 0 }) };
  });
  route('GET', '/api/admin/daily', ['admin'], ({ query }) => {
    const { from, to } = range(query);
    const [pw, pa] = pf(query);
    const rows = db.prepare(`SELECT date(${L}) day, COUNT(DISTINCT s.id) orders, SUM(i.qty*i.price) revenue,
        SUM(i.qty*(i.price-i.cost)) profit, SUM(i.qty) items FROM sales s JOIN sale_items i ON i.sale_id=s.id
      WHERE date(${L}) BETWEEN ? AND ? ${pw} GROUP BY day`).all(...[from, to, pa].filter((x) => x !== null));
    const map = new Map(rows.map((r) => [r.day, r]));
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(map.get(d) || { day: d, orders: 0, revenue: 0, profit: 0, items: 0 });
    return { from, to, days };
  });
  route('GET', '/api/admin/top-products', ['admin'], ({ query }) => {
    const { from, to } = range(query);
    const by = query.by === 'profit' ? 'profit' : query.by === 'qty' ? 'qty' : 'revenue';
    return db.prepare(`SELECT p.id,p.name,p.unit,p.stock, SUM(i.qty) qty, SUM(i.qty*i.price) revenue, SUM(i.qty*(i.price-i.cost)) profit
      FROM sale_items i JOIN sales s ON s.id=i.sale_id JOIN products p ON p.id=i.product_id
      WHERE date(${L}) BETWEEN ? AND ? GROUP BY p.id ORDER BY ${by} DESC LIMIT 50`).all(from, to);
  });
  route('GET', '/api/admin/sellers', ['admin'], ({ query }) => {
    const { from, to } = range(query);
    return db.prepare(`SELECT u.id,u.name, COUNT(DISTINCT s.id) orders, SUM(i.qty*i.price) revenue
      FROM sales s JOIN users u ON u.id=s.user_id JOIN sale_items i ON i.sale_id=s.id
      WHERE date(${L}) BETWEEN ? AND ? GROUP BY u.id ORDER BY revenue DESC`).all(from, to);
  });
  route('GET', '/api/admin/stock-moves', ['admin'], ({ query }) => {
    const pid = query.product_id ? num(query.product_id, 'product_id', { int: true }) : null;
    return db.prepare(`SELECT m.*,p.name product,u.name user FROM stock_moves m JOIN products p ON p.id=m.product_id
      LEFT JOIN users u ON u.id=m.user_id ${pid ? 'WHERE m.product_id=?' : ''} ORDER BY m.id DESC LIMIT 200`).all(...(pid ? [pid] : []));
  });

  // ---------- Admin: kam qolgan mahsulotlarga xarid taklifi ----------
  // Taklif: oxirgi `window` kundagi o'rtacha kunlik sotuv asosida `cover` kunga yetadigan miqdor.
  const buildOffers = ({ window = 30, cover = 14, lead = 3 } = {}) => {
    const today = localToday();
    const rows = db.prepare(`SELECT p.id,p.name,p.unit,p.stock,p.min_stock,p.cost,
        COALESCE((SELECT SUM(i.qty) FROM sale_items i JOIN sales s ON s.id=i.sale_id
                  WHERE i.product_id=p.id AND date(${L}) BETWEEN ? AND ?),0) sold,
        (SELECT r.supplier_id FROM receipt_items ri JOIN receipts r ON r.id=ri.receipt_id
          WHERE ri.product_id=p.id AND r.supplier_id IS NOT NULL ORDER BY r.id DESC LIMIT 1) supplier_id,
        (SELECT COALESCE(SUM(pi.qty),0) FROM po_items pi JOIN purchase_orders o ON o.id=pi.po_id
          WHERE pi.product_id=p.id AND o.status='ordered') on_order
      FROM products p WHERE p.active=1`).all(addDays(today, -window + 1), today);
    const sup = new Map(db.prepare('SELECT id,name,phone FROM suppliers').all().map((s) => [s.id, s]));
    const out = [];
    for (const r of rows) {
      const daily = r.sold / window;
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
    const supplier_id = body.supplier_id ? num(body.supplier_id, 'Yetkazib beruvchi', { int: true, min: 1 }) : null;
    return tx(db, () => {
      let total = 0;
      for (const it of items) {
        if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(it.product_id)) throw bad('Mahsulot topilmadi');
        total += Math.round(it.qty * it.cost);
      }
      const id = Number(db.prepare('INSERT INTO purchase_orders(supplier_id,created_by,total) VALUES(?,?,?)').run(supplier_id, user.id, total).lastInsertRowid);
      for (const it of items) db.prepare('INSERT INTO po_items(po_id,product_id,qty,cost) VALUES(?,?,?,?)').run(id, it.product_id, it.qty, it.cost);
      return { id, total };
    });
  });
  route('GET', '/api/admin/purchase-orders', ['admin'], () => {
    const orders = db.prepare(`SELECT o.*,s.name supplier,s.phone supplier_phone FROM purchase_orders o LEFT JOIN suppliers s ON s.id=o.supplier_id ORDER BY o.id DESC LIMIT 100`).all();
    const it = db.prepare('SELECT i.product_id,p.name,p.unit,i.qty,i.cost FROM po_items i JOIN products p ON p.id=i.product_id WHERE i.po_id=?');
    return orders.map((o) => ({ ...o, items: it.all(o.id) }));
  });
  route('POST', '/api/admin/purchase-orders/:id/receive', ['admin'], ({ params, user }) => tx(db, () => {
    const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(params.id);
    if (!o) throw new HttpError(404, 'Buyurtma topilmadi');
    if (o.status !== 'ordered') throw new HttpError(409, 'Buyurtma allaqachon yopilgan');
    const items = db.prepare('SELECT product_id,qty,cost FROM po_items WHERE po_id=?').all(o.id);
    const r = receiveStock({ items, supplier_id: o.supplier_id, note: `Buyurtma #${o.id}`, user, source: 'purchase' });
    db.prepare("UPDATE purchase_orders SET status='received', closed_at=datetime('now') WHERE id=?").run(o.id);
    return r;
  }));
  route('POST', '/api/admin/purchase-orders/:id/cancel', ['admin'], ({ params }) => {
    const r = db.prepare("UPDATE purchase_orders SET status='cancelled', closed_at=datetime('now') WHERE id=? AND status='ordered'").run(params.id);
    if (!r.changes) throw new HttpError(409, 'Buyurtmani bekor qilib bo\'lmaydi');
    return { ok: true };
  });

  // ---------- Admin: foydalanuvchilar ----------
  route('GET', '/api/admin/users', ['admin'], () => db.prepare('SELECT id,username,name,role,active FROM users ORDER BY id').all());
  route('POST', '/api/admin/users', ['admin'], ({ body }) => {
    const role = body.role === 'admin' ? 'admin' : 'seller';
    const pw = str(body.password, 'Parol', 100);
    if (pw.length < 6) throw bad('Parol kamida 6 belgi');
    try {
      return { id: Number(db.prepare('INSERT INTO users(username,name,role,password_hash) VALUES(?,?,?,?)')
        .run(str(body.username, 'Login', 40), str(body.name, 'Ism', 80), role, hashPassword(pw)).lastInsertRowid) };
    } catch (e) { if (/UNIQUE/.test(e.message)) throw bad('Bunday login band'); throw e; }
  });
  route('PUT', '/api/admin/users/:id', ['admin'], ({ params, body, user }) => {
    if (Number(params.id) === user.id && body.active === false) throw bad('O\'zingizni o\'chira olmaysiz');
    if (body.password) {
      if (String(body.password).length < 6) throw bad('Parol kamida 6 belgi');
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(String(body.password)), params.id);
    }
    if (typeof body.active === 'boolean') {
      db.prepare('UPDATE users SET active=? WHERE id=?').run(body.active ? 1 : 0, params.id);
      if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(params.id);
    }
    return { ok: true };
  });

  // ---------- HTTP ----------
  const cookie = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 1e6) { reject(new HttpError(413, 'So\'rov juda katta')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(bad('JSON xato')); } });
  });
  const send = (res, status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const sessionUser = (req) => {
    const t = cookie(req).sid;
    if (!t) return null;
    return db.prepare(`SELECT u.id,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token=? AND u.active=1 AND s.created_at > datetime('now','-12 hours')`).get(t) || null;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
        if (!r) throw new HttpError(404, 'Topilmadi');
        const user = sessionUser(req);
        if (r.roles && (!user || (r.roles.length && !r.roles.includes(user.role)))) {
          throw new HttpError(user ? 403 : 401, user ? 'Ruxsat yo\'q' : 'Kirish talab qilinadi');
        }
        if (req.method !== 'GET' && r.roles && req.headers['x-requested-with'] !== 'erp') throw new HttpError(403, 'CSRF');
        const m = url.pathname.match(r.re);
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'GET' ? {} : await readBody(req);
        return send(res, 200, await r.handler({ req, res, user, params, body, query: Object.fromEntries(url.searchParams), ip: req.socket.remoteAddress }));
      }
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^([/\\])+/, '');
      if (rel.includes('..')) throw new HttpError(404, 'Topilmadi');
      const data = await readFile(join(PUBLIC, rel)).catch(() => { throw new HttpError(404, 'Topilmadi'); });
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" });
      res.end(data);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Server xatosi' });
    }
  });
}
