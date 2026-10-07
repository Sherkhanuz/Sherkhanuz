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
  const custIds = await bulk(t, 'customers', ['name', 'phone'], [['Karim aka', '+998909990001'], ['Dilnoza opa', '+998909990002']], true);
  const ids = await bulk(t, 'products', ['sku', 'name', 'category', 'unit', 'price', 'cost', 'min_stock'],
    P.map((p, i) => [ean13('4600000000' + String(100 + i).slice(-2)), p[0], p[1], p[2], p[3], p[4], p[5]]), true);

  // 1) Sotuvlar xotirada tuziladi (qoldiq tarixdan kelib chiqadi: hech narsa "yo'qdan" paydo bo'lmaydi)
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const sales = [];
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
      if (mine.length) sales.push({ at: iso(ms), mine, method: ['cash', 'card'][rnd(2)], customer: null, paid: null });
    }
  }
  // Nasiya demosi: Karim akaga 5 dona yog' (120 000 so'm), to'lanmagan
  sales.push({ at: iso(now - 864e5), mine: [{ i: 2, qty: 5 }], method: 'cash', customer: custIds[0], paid: 0 });
  for (const s of sales) { s.total = s.mine.reduce((a, l) => a + l.qty * P[l.i][3], 0); if (s.paid === null) s.paid = s.total; }
  const sold = P.map(() => 0);
  sales.forEach((s) => s.mine.forEach((l) => { sold[l.i] += l.qty; }));

  // 2) Boshlang'ich kirim (31 kun oldin), yetkazib beruvchi bo'yicha: qoldiq = sotilgan + hozirgi maqsad qoldiq
  const day0 = iso(now - 31 * 864e5);
  const finalStock = P.map((p, i) => (i in LOW ? LOW[i] : p[5] + 5 + rnd(20)));
  const recIds = {}, recMoves = [];
  for (let sp = 0; sp < 3; sp++) {
    const mine = P.map((p, i) => [p, i]).filter(([p]) => p[7] === sp);
    const lines = mine.map(([p, i]) => ({ i, qty: sold[i] + finalStock[i], cost: p[4] }));
    const total = lines.reduce((a, l) => a + l.qty * l.cost, 0); // hujjat o'zgarmas: jami oldindan
    const [rid] = await bulk(t, 'receipts', ['user_id', 'supplier_id', 'note', 'total', 'created_at'], [[seller, supIds[sp], 'Boshlang\'ich kirim', total, day0]], true);
    await bulk(t, 'receipt_items', ['receipt_id', 'product_id', 'qty', 'cost', 'line_total'], lines.map((l) => [rid, ids[l.i], l.qty, l.cost, l.qty * l.cost]));
    lines.forEach((l) => recMoves.push([ids[l.i], 'receipt', l.qty, null, rid, seller, day0]));
  }
  await bulk(t, 'stock_moves', ['product_id', 'type', 'qty', 'sale_id', 'receipt_id', 'user_id', 'created_at'], recMoves);

  // 3) Sotuv hujjatlari, qatorlari, ombor harakatlari va mijoz daftari
  const saleIds = await bulk(t, 'sales', ['user_id', 'customer_id', 'total', 'paid', 'method', 'created_at'], sales.map((s) => [seller, s.customer, s.total, s.paid, s.method, s.at]), true);
  const lines = [];
  sales.forEach((s, k) => s.mine.forEach((l) => lines.push({ sale: saleIds[k], i: l.i, qty: l.qty, at: s.at })));
  await bulk(t, 'sale_items', ['sale_id', 'product_id', 'qty', 'price', 'line_total', 'cost'], lines.map((l) => [l.sale, ids[l.i], l.qty, P[l.i][3], l.qty * P[l.i][3], P[l.i][4]]));
  await bulk(t, 'stock_moves', ['product_id', 'type', 'qty', 'sale_id', 'receipt_id', 'user_id', 'created_at'], lines.map((l) => [ids[l.i], 'sale', -l.qty, l.sale, null, seller, l.at]));
  const credit = sales.map((s, k) => [s, k]).filter(([s]) => s.paid < s.total);
  await bulk(t, 'customer_ledger', ['customer_id', 'kind', 'amount', 'sale_id', 'created_at'], credit.map(([s, k]) => [s.customer, 'sale_debt', s.total - s.paid, saleIds[k], s.at]));
});
console.log('Demo ma\'lumot yuklandi.');
await db.close();
