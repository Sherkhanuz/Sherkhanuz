// Demo ma'lumot: mahsulotlar, yetkazib beruvchilar va 30 kunlik sotuv tarixi.
import { openDb, ensureDefaultUsers, tx, TZ_HOURS } from './db.js';

const db = openDb();
ensureDefaultUsers(db);
if (db.prepare('SELECT COUNT(*) c FROM products').get().c) { console.log('Baza bo\'sh emas, seed o\'tkazib yuborildi.'); process.exit(0); }

const seller = db.prepare("SELECT id FROM users WHERE role='seller' LIMIT 1").get().id;
const sup = ['Orient Savdo', 'Baraka Opt', 'Fresh Group'].map((n, i) =>
  Number(db.prepare('INSERT INTO suppliers(name,phone) VALUES(?,?)').run(n, `+99890123${i}${i}${i}${i}`).lastInsertRowid));

// [nom, kategoriya, birlik, sotuv narxi, tannarx, boshlang'ich qoldiq, minimal, kunlik o'rtacha sotuv, yetkazuvchi]
const P = [
  ['Non', 'Oziq-ovqat', 'dona', 4000, 3000, 40, 30, 45, 2], ['Sut 1L', 'Oziq-ovqat', 'dona', 12000, 9500, 35, 20, 18, 2],
  ['Yog\' 1L', 'Oziq-ovqat', 'dona', 24000, 20000, 25, 10, 6, 1], ['Guruch 1kg', 'Oziq-ovqat', 'kg', 16000, 13000, 60, 20, 9, 1],
  ['Shakar 1kg', 'Oziq-ovqat', 'kg', 13000, 10500, 50, 20, 8, 1], ['Choy 100g', 'Oziq-ovqat', 'dona', 15000, 11000, 30, 10, 5, 1],
  ['Tuxum 10 dona', 'Oziq-ovqat', 'dona', 20000, 16500, 20, 10, 12, 2], ['Makaron', 'Oziq-ovqat', 'dona', 8000, 6000, 45, 15, 7, 1],
  ['Coca-Cola 1.5L', 'Ichimlik', 'dona', 11000, 8500, 48, 24, 20, 0], ['Suv 1.5L', 'Ichimlik', 'dona', 4000, 2500, 60, 30, 25, 0],
  ['Fanta 1L', 'Ichimlik', 'dona', 9000, 6800, 24, 12, 8, 0], ['Sharbat 1L', 'Ichimlik', 'dona', 14000, 10500, 18, 10, 5, 0],
  ['Shokolad', 'Shirinlik', 'dona', 9000, 6500, 40, 15, 14, 0], ['Pechenye', 'Shirinlik', 'dona', 7000, 5000, 35, 15, 10, 0],
  ['Chips', 'Shirinlik', 'dona', 10000, 7500, 30, 15, 11, 0], ['Sovun', 'Xo\'jalik', 'dona', 6000, 4200, 40, 10, 4, 1],
  ['Kir yuvish kukuni 1kg', 'Xo\'jalik', 'dona', 28000, 22000, 15, 8, 3, 1], ['Shampun', 'Xo\'jalik', 'dona', 32000, 24000, 12, 6, 2, 1],
  ['Tish pastasi', 'Xo\'jalik', 'dona', 14000, 10000, 20, 8, 3, 1], ['Qog\'oz salfetka', 'Xo\'jalik', 'dona', 5000, 3200, 40, 10, 6, 1],
  ['Sigaret', 'Boshqa', 'pachka', 18000, 15500, 80, 30, 30, 2], ['Batareya AA', 'Boshqa', 'dona', 6000, 3800, 30, 10, 2, 2],
  ['Shokolad batonchik', 'Shirinlik', 'dona', 5000, 3500, 50, 20, 16, 0], ['Qatiq 0.5L', 'Oziq-ovqat', 'dona', 8000, 6000, 20, 10, 10, 2],
];

// Soatlik talab: ertalab va kechki cho'qqilar
const HOUR_W = [0,0,0,0,0,0,1,3,6,5,4,4,5,5,4,4,5,7,9,8,5,3,1,0];
const rnd = (n) => Math.floor(Math.random() * n);
const pickHour = () => { let r = Math.random() * HOUR_W.reduce((a, b) => a + b); for (let h = 0; h < 24; h++) { r -= HOUR_W[h]; if (r < 0) return h; } return 12; };

tx(db, () => {
  const ids = P.map((p) => Number(db.prepare('INSERT INTO products(sku,name,category,unit,price,cost,stock,min_stock) VALUES(?,?,?,?,?,?,?,?)')
    .run(`P${String(p[0].length).padStart(2, '0')}${rnd(900) + 100}`, p[0], p[1], p[2], p[3], p[4], 0, p[6]).lastInsertRowid));
  const stock = P.map(() => 0);
  const addSale = (when, lines) => {
    const total = lines.reduce((a, l) => a + l.qty * l.price, 0);
    const sid = Number(db.prepare('INSERT INTO sales(user_id,total,method,created_at) VALUES(?,?,?,?)').run(seller, total, ['cash', 'card'][rnd(2)], when).lastInsertRowid);
    for (const l of lines) {
      db.prepare('INSERT INTO sale_items(sale_id,product_id,qty,price,cost) VALUES(?,?,?,?,?)').run(sid, ids[l.i], l.qty, l.price, l.cost);
      db.prepare('INSERT INTO stock_moves(product_id,type,qty,ref_id,user_id,created_at) VALUES(?,?,?,?,?,?)').run(ids[l.i], 'sale', -l.qty, sid, seller, when);
      stock[l.i] -= l.qty;
    }
  };
  // Boshlang'ich kirim (30 kun oldin), keyin sotuvlar
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const rid = Number(db.prepare('INSERT INTO receipts(user_id,supplier_id,note,total,created_at) VALUES(?,?,?,0,?)').run(seller, null, 'Boshlang\'ich qoldiq', iso(now - 31 * 864e5)).lastInsertRowid);
  P.forEach((p, i) => {
    const q = Math.ceil(p[7] * 32 + 5); stock[i] += q;
    db.prepare('INSERT INTO receipt_items(receipt_id,product_id,qty,cost) VALUES(?,?,?,?)').run(rid, ids[i], q, p[4]);
    db.prepare('INSERT INTO stock_moves(product_id,type,qty,ref_id,user_id,created_at) VALUES(?,?,?,?,?,?)').run(ids[i], 'receipt', q, rid, seller, iso(now - 31 * 864e5));
  });
  for (let d = 29; d >= 0; d--) {
    const dayStart = new Date(now - d * 864e5); dayStart.setUTCHours(0, 0, 0, 0);
    const orders = 40 + rnd(25) + (d % 7 === 0 ? 20 : 0);
    for (let k = 0; k < orders; k++) {
      const hourLocal = pickHour();
      const ms = dayStart.getTime() + ((hourLocal - TZ_HOURS + 24) % 24) * 3600e3 + rnd(3600) * 1000;
      if (ms > now) continue;
      const lines = []; const used = new Set();
      for (let n = 1 + rnd(4); n > 0; n--) {
        const i = rnd(P.length); if (used.has(i)) continue;
        // mashhur mahsulotlar ko'proq tanlansin
        if (Math.random() * 45 > P[i][7] + 6) continue;
        used.add(i); lines.push({ i, qty: 1 + rnd(2), price: P[i][3], cost: P[i][4] });
      }
      if (lines.length) addSale(iso(ms), lines);
    }
  }
  // Ba'zi mahsulotlar ataylab kam qolsin (taklif demosi uchun)
  stock.forEach((s, i) => {
    const want = [0, 3, 8, 1, 12].includes(i) ? [0, 4, 2, 5, 6][[0, 3, 8, 1, 12].indexOf(i)] : Math.max(s, P[i][6] + 5);
    db.prepare('UPDATE products SET stock=? WHERE id=?').run(want, ids[i]);
  });
  P.forEach((p, i) => db.prepare('INSERT INTO receipts(user_id,supplier_id,note,total,created_at) VALUES(?,?,?,0,?)').run(seller, sup[p[8] % 3], 'Seed', iso(now - 15 * 864e5)));
  // yetkazib beruvchini mahsulotga bog'lash uchun kirim qatorlari
  const lastR = db.prepare('SELECT id FROM receipts ORDER BY id DESC LIMIT ?').all(P.length).reverse();
  lastR.forEach((r, i) => db.prepare('INSERT INTO receipt_items(receipt_id,product_id,qty,cost) VALUES(?,?,?,?)').run(r.id, ids[i], 0.0001, P[i][4]));
});
console.log('Demo ma\'lumot yuklandi. Kirish: admin/admin123, sotuvchi/sotuvchi123');
