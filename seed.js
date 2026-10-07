// Demo ma'lumot: mahsulotlar, yetkazib beruvchilar, nasiyachi mijozlar va 30 kunlik sotuv tarixi.
// Ishga tushirish: npm run seed  (DATABASE_URL bo'lsa Neon'ga, bo'lmasa lokal PGlite'ga yoziladi)
import { openDb, ensureReady } from './db.js';

const db = await openDb();
await ensureReady(db);
if ((await db.one('SELECT COUNT(*)::int c FROM products')).c) { console.log('Baza bo\'sh emas, seed o\'tkazib yuborildi.'); await db.close(); process.exit(0); }

const seller = (await db.one("SELECT id FROM users WHERE role='seller' ORDER BY id LIMIT 1") || await db.one('SELECT id FROM users ORDER BY id LIMIT 1')).id;
// EAN-13 (nazorat raqami bilan) — demo mahsulotlar kamera bilan skanerlanadigan bo'lsin
const ean13 = (body12) => body12 + ((10 - [...body12].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0) % 10) % 10);
const rnd = (n) => Math.floor(Math.random() * n);

// [nom, kategoriya, birlik, sotuv narxi, tannarx, minimal, kunlik o'rtacha sotuv, yetkazuvchi indeksi]
const P = [
  ['Non', 'Oziq-ovqat', 'dona', 4000, 3000, 30, 45, 2], ['Sut 1L', 'Oziq-ovqat', 'dona', 12000, 9500, 20, 18, 2],
  ['Yog\' 1L', 'Oziq-ovqat', 'dona', 24000, 20000, 10, 6, 1], ['Guruch 1kg', 'Oziq-ovqat', 'kg', 16000, 13000, 20, 9, 1],
  ['Shakar 1kg', 'Oziq-ovqat', 'kg', 13000, 10500, 20, 8, 1], ['Choy 100g', 'Oziq-ovqat', 'dona', 15000, 11000, 10, 5, 1],
  ['Tuxum 10 dona', 'Oziq-ovqat', 'dona', 20000, 16500, 10, 12, 2], ['Makaron', 'Oziq-ovqat', 'dona', 8000, 6000, 15, 7, 1],
  ['Coca-Cola 1.5L', 'Ichimlik', 'dona', 11000, 8500, 24, 20, 0], ['Suv 1.5L', 'Ichimlik', 'dona', 4000, 2500, 30, 25, 0],
  ['Fanta 1L', 'Ichimlik', 'dona', 9000, 6800, 12, 8, 0], ['Sharbat 1L', 'Ichimlik', 'dona', 14000, 10500, 10, 5, 0],
  ['Shokolad', 'Shirinlik', 'dona', 9000, 6500, 15, 14, 0], ['Pechenye', 'Shirinlik', 'dona', 7000, 5000, 15, 10, 0],
  ['Chips', 'Shirinlik', 'dona', 10000, 7500, 15, 11, 0], ['Sovun', 'Xo\'jalik', 'dona', 6000, 4200, 10, 4, 1],
  ['Kir yuvish kukuni 1kg', 'Xo\'jalik', 'dona', 28000, 22000, 8, 3, 1], ['Shampun', 'Xo\'jalik', 'dona', 32000, 24000, 6, 2, 1],
  ['Tish pastasi', 'Xo\'jalik', 'dona', 14000, 10000, 8, 3, 1], ['Qog\'oz salfetka', 'Xo\'jalik', 'dona', 5000, 3200, 10, 6, 1],
  ['Sigaret', 'Boshqa', 'pachka', 18000, 15500, 30, 30, 2], ['Batareya AA', 'Boshqa', 'dona', 6000, 3800, 10, 2, 2],
  ['Shokolad batonchik', 'Shirinlik', 'dona', 5000, 3500, 20, 16, 0], ['Qatiq 0.5L', 'Oziq-ovqat', 'dona', 8000, 6000, 10, 10, 2],
];
// Kam qolishi kerak mahsulotlar (taklif demosi): indeks -> qoldiq
const LOW = { 0: 0, 3: 4, 8: 2, 1: 5, 12: 6 };
const HOUR_W = [0,0,0,0,0,0,1,3,6,5,4,4,5,5,4,4,5,7,9,8,5,3,1,0];
const pickHour = () => { let r = Math.random() * HOUR_W.reduce((a, b) => a + b); for (let h = 0; h < 24; h++) { r -= HOUR_W[h]; if (r < 0) return h; } return 12; };

// Ko'p qatorli INSERT (tarmoq kechikishi uchun partiyalab)
async function bulk(t, table, cols, rows, ret = false) {
  const out = [];
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const vals = chunk.map((_, r) => `(${cols.map((__, c) => `$${r * cols.length + c + 1}`).join(',')})`).join(',');
    const res = await t.q(`INSERT INTO ${table}(${cols.join(',')}) VALUES ${vals}${ret ? ' RETURNING id' : ''}`, chunk.flat());
    if (ret) out.push(...res.map((x) => x.id));
  }
  return out;
}

await db.tx(async (t) => {
  const supIds = await bulk(t, 'suppliers', ['name', 'phone'], [['Orient Savdo', '+998901110000'], ['Baraka Opt', '+998902220000'], ['Fresh Group', '+998903330000']], true);
  const custIds = await bulk(t, 'customers', ['name', 'phone', 'balance'], [['Karim aka', '+998909990001', 0], ['Dilnoza opa', '+998909990002', 0]], true);
  const ids = await bulk(t, 'products', ['sku', 'name', 'category', 'unit', 'price', 'cost', 'stock', 'min_stock'],
    P.map((p, i) => [ean13('4600000000' + String(100 + i).slice(-2)), p[0], p[1], p[2], p[3], p[4], 0, p[5]]), true);

  const now = Date.now();
  const stock = P.map(() => 0);
  const day0 = new Date(now - 31 * 864e5).toISOString();
  // Boshlang'ich kirim: yetkazib beruvchi bo'yicha
  for (let s = 0; s < 3; s++) {
    const mine = P.map((p, i) => [p, i]).filter(([p]) => p[7] === s);
    const q = mine.map(([p]) => Math.ceil(p[6] * 32 + 5));
    const total = mine.reduce((a, [p], k) => a + q[k] * p[4], 0); // hujjat o'zgarmas: jami oldindan hisoblanadi
    const [rid] = await bulk(t, 'receipts', ['user_id', 'supplier_id', 'note', 'total', 'created_at'], [[seller, supIds[s], 'Boshlang\'ich qoldiq', total, day0]], true);
    const items = mine.map(([p, i], k) => { stock[i] += q[k]; return [rid, ids[i], q[k], p[4]]; });
    await bulk(t, 'receipt_items', ['receipt_id', 'product_id', 'qty', 'cost'], items);
    await bulk(t, 'stock_moves', ['product_id', 'type', 'qty', 'ref_id', 'user_id', 'created_at'], items.map((x) => [x[1], 'receipt', x[2], rid, seller, day0]));
  }

  // Sotuvlar xotirada tuziladi, keyin partiyalab yoziladi
  const sales = []; const lines = [];
  for (let d = 29; d >= 0; d--) {
    const dayStart = new Date(now - d * 864e5); dayStart.setUTCHours(0, 0, 0, 0);
    const orders = 40 + rnd(25) + (d % 7 === 0 ? 20 : 0);
    for (let k = 0; k < orders; k++) {
      // Toshkent soati -> UTC (UTC+5)
      const ms = dayStart.getTime() + ((pickHour() - 5 + 24) % 24) * 3600e3 + rnd(3600) * 1000;
      if (ms > now) continue;
      const used = new Set(); const mine = [];
      for (let n = 1 + rnd(4); n > 0; n--) {
        const i = rnd(P.length);
        if (used.has(i) || Math.random() * 45 > P[i][6] + 6) continue;
        used.add(i); mine.push({ i, qty: 1 + rnd(2) });
      }
      if (!mine.length) continue;
      const total = mine.reduce((a, l) => a + l.qty * P[l.i][3], 0);
      sales.push({ at: new Date(ms).toISOString(), total, mine, method: ['cash', 'card'][rnd(2)] });
    }
  }
  const saleIds = await bulk(t, 'sales', ['user_id', 'total', 'paid', 'method', 'created_at'], sales.map((s) => [seller, s.total, s.total, s.method, s.at]), true);
  sales.forEach((s, k) => s.mine.forEach((l) => {
    stock[l.i] -= l.qty;
    lines.push({ sale: saleIds[k], i: l.i, qty: l.qty, at: s.at });
  }));
  await bulk(t, 'sale_items', ['sale_id', 'product_id', 'qty', 'price', 'line_total', 'cost'], lines.map((l) => [l.sale, ids[l.i], l.qty, P[l.i][3], l.qty * P[l.i][3], P[l.i][4]]));
  await bulk(t, 'stock_moves', ['product_id', 'type', 'qty', 'ref_id', 'user_id', 'created_at'], lines.map((l) => [ids[l.i], 'sale', -l.qty, l.sale, seller, l.at]));

  // Bir nechta nasiya: bugun Karim akaga 120 000 so'mlik qarz
  await t.run('UPDATE customers SET balance=120000 WHERE id=?', [custIds[0]]);

  // Qoldiqlarni yozish; ba'zilari ataylab kam (xarid taklifi demosi uchun)
  for (const [i, id] of ids.entries()) {
    const want = i in LOW ? LOW[i] : Math.max(stock[i], P[i][5] + 5);
    const diff = want - stock[i];
    await t.run('UPDATE products SET stock=? WHERE id=?', [want, id]);
    if (diff) await t.run('INSERT INTO stock_moves(product_id,type,qty,user_id) VALUES(?,?,?,?)', [id, 'adjust', diff, seller]);
  }
});
console.log('Demo ma\'lumot yuklandi.');
await db.close();
