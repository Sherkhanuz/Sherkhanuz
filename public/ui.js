// Mini ERP — mijoz tomoni (vanilla JS, DOM orqali; matn har doim textContent bilan qo'yiladi)
import { openScanner } from './scanner.js';
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    // 'change' blur paytida, element olib tashlanayotganda ham ishga tushadi — qayta chizish xatosi bo'lmasin deb keyinga suriladi
    if (k === 'onchange') el.addEventListener('change', (e) => setTimeout(() => v(e), 0));
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/,/g, ' ');
const qf = (n) => String(Math.round(Number(n) * 1000) / 1000);
const money = (n) => fmt(n) + " so'm";
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const hhmm = (s) => new Date(s).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'erp' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { state.user = null; render(); throw new Error(data.error); }
  if (!r.ok) throw new Error(data.error || 'Xato');
  return data;
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b || {});

const state = { user: null, tab: null, scanner: null };
const root = $('#root');

// ---------- diagramma (inline SVG) ----------
function barChart(items, { label, value, format = fmt, height = 160 } = {}) {
  const W = 720, pad = 24, bw = (W - pad) / items.length;
  const max = Math.max(1, ...items.map(value));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${height + 20}`); svg.setAttribute('class', 'chart'); svg.style.width = '100%';
  const every = Math.ceil(items.length / 12);
  items.forEach((it, i) => {
    const v = value(it), bh = (v / max) * height, x = pad + i * bw;
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('class', 'bar'); r.setAttribute('x', x + 1); r.setAttribute('width', Math.max(bw - 2, 1));
    r.setAttribute('y', height - bh); r.setAttribute('height', bh); r.setAttribute('rx', 2);
    const t = document.createElementNS(ns, 'title'); t.textContent = `${label(it)}: ${format(v)}`; r.append(t); svg.append(r);
    if (i % every === 0) { const tx = document.createElementNS(ns, 'text'); tx.setAttribute('x', x + bw / 2); tx.setAttribute('y', height + 13); tx.setAttribute('text-anchor', 'middle'); tx.textContent = label(it); svg.append(tx); }
  });
  const m = document.createElementNS(ns, 'text'); m.setAttribute('x', 0); m.setAttribute('y', 10); m.textContent = format(max); svg.append(m);
  return svg;
}

const msgBox = () => h('div');
const stepper = (n, onMinus, onPlus) => h('div', { class: 'sc-step' }, h('button', { type: 'button', onclick: onMinus, 'aria-label': 'Kamaytirish' }, '−'), h('span', {}, qf(n)), h('button', { type: 'button', onclick: onPlus, 'aria-label': 'Ko\'paytirish' }, '+'));
function flash(box, text, kind = 'err') { box.replaceChildren(text ? h('div', { class: 'msg ' + kind }, text) : ''); }
const table = (head, rows, numCols = []) => h('div', { class: 'wrap' }, h('table', {},
  h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: numCols.includes(i) ? 'n' : '' }, t)))),
  h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numCols.includes(i) ? 'n' : '' }, c)))))));
const activeTag = (a) => h('span', { class: 'tag ' + (a ? 'ok' : 'cancelled') }, a ? 'Aktiv' : 'Noaktiv');
const STATUS_OPTS = () => [h('option', { value: 'active' }, 'Aktiv'), h('option', { value: 'inactive' }, 'Noaktiv'), h('option', { value: 'all' }, 'Hammasi')];
const stockTag = (p) => p.stock <= 0 ? h('span', { class: 'tag out' }, 'Tugagan') : p.stock <= p.min_stock ? h('span', { class: 'tag low' }, 'Kam') : h('span', { class: 'tag ok' }, 'Yetarli');

// ---------- Kirish ----------
function loginView() {
  const box = msgBox();
  const u = h('input', { placeholder: 'Login', autocomplete: 'username', autofocus: true });
  const p = h('input', { placeholder: 'Parol', type: 'password', autocomplete: 'current-password' });
  const go = async (e) => {
    e.preventDefault();
    try { state.user = await post('/api/login', { username: u.value, password: p.value }); state.tab = null; render(); }
    catch (err) { flash(box, err.message); }
  };
  return h('form', { class: 'login card', onsubmit: go }, h('h2', {}, 'Mini ERP'), h('p', { class: 'mute' }, "Do'kon boshqaruviga kirish"), box, u, p, h('button', { class: 'btn', style: 'width:100%' }, 'Kirish'));
}

// ---------- Sotuvchi: Sotuv ----------
function printReceipt(r) {
  let el = $('#print');
  if (!el) { el = h('div', { id: 'print' }); document.body.append(el); }
  el.replaceChildren(...[h('h3', {}, 'Mini ERP'), h('div', {}, `Chek №${r.id} · ${hhmm(new Date().toISOString())}`), h('hr'),
    ...r.lines.map((l) => h('div', { class: 'rl' }, h('span', {}, `${l.name} ×${qf(l.qty)}`), h('span', {}, fmt(l.total)))), h('hr'),
    h('div', { class: 'rl' }, h('span', {}, 'Jami'), h('span', {}, fmt(r.subtotal))),
    r.discount ? h('div', { class: 'rl' }, h('span', {}, 'Chegirma'), h('span', {}, '−' + fmt(r.discount))) : null,
    h('div', { class: 'rl' }, h('b', {}, "To'lash kerak"), h('b', {}, fmt(r.total))),
    r.debt ? h('div', { class: 'rl' }, h('span', {}, 'Nasiya'), h('span', {}, fmt(r.debt))) : null, h('p', {}, 'Xaridingiz uchun rahmat!')].filter(Boolean));
  window.print();
}

async function sellView() {
  const [products, customers] = await Promise.all([get('/api/products'), get('/api/customers')]);
  const cart = new Map(); // id -> qty
  const box = msgBox(), list = h('div', { class: 'pick' }), cartEl = h('div'), sumEl = h('div'), lastEl = h('div');
  const q = h('input', { placeholder: 'Nomi yoki shtrixkod (skaner + Enter)...', style: 'flex:1', autofocus: true });
  const method = h('select', {}, h('option', { value: 'cash' }, 'Naqd'), h('option', { value: 'card' }, 'Karta'), h('option', { value: 'transfer' }, "O'tkazma"));
  const cust = h('select', { onchange: () => drawCart() }, h('option', { value: '' }, '— mijoz yo\'q —'), customers.map((c) => h('option', { value: c.id }, c.name)));
  const dType = h('select', { onchange: () => drawCart() }, h('option', { value: 'amount' }, "so'm"), h('option', { value: 'percent' }, '%'));
  const dVal = h('input', { type: 'number', min: 0, step: 'any', value: 0, oninput: () => drawCart() });
  const paid = h('input', { type: 'number', min: 0, placeholder: "to'langan (bo'sh = to'liq)", style: 'width:170px', oninput: () => drawCart() });
  const byId = new Map(products.map((p) => [p.id, p]));
  const addToCart = (p) => { if (p.stock > 0) { cart.set(p.id, Math.min((cart.get(p.id) || 0) + 1, p.stock)); drawCart(); } };
  const matches = () => { const s = q.value.trim().toLowerCase(); return products.filter((p) => !s || p.name.toLowerCase().includes(s) || (p.sku || '').toLowerCase().includes(s)); };
  const drawList = () => list.replaceChildren(...matches().slice(0, 60).map((p) =>
    h('button', { disabled: p.stock <= 0, onclick: () => addToCart(p) }, h('span', {}, p.name), h('span', { class: 'mute' }, `${money(p.price)} · ${qf(p.stock)} ${p.unit}`))));
  // Kamera rejimi: pastki panelda jonli savat, +/- tugmalar va skanerdan chiqmasdan "Sotish"
  const scanPanel = h('div', { class: 'scan-cart' });
  const drawScanPanel = (flashId) => {
    const c = calc(); const qty = [...cart.values()].reduce((a, b) => a + b, 0);
    scanPanel.replaceChildren(
      h('div', { class: 'sc-list' }, cart.size ? [...cart].reverse().map(([id, n]) => {
        const p = byId.get(id);
        return h('div', { class: 'sc-row' + (id === flashId ? ' new' : '') },
          h('div', { class: 'sc-name' }, h('b', {}, p.name), h('span', { class: 'mute' }, `${money(p.price)} · ${qf(p.stock)} ${p.unit}`)),
          stepper(n, () => { n - 1 > 0 ? cart.set(id, n - 1) : cart.delete(id); drawCart(); }, () => { if (n + 1 <= p.stock) { cart.set(id, n + 1); drawCart(); } else state.scanner?.notify(`"${p.name}" omborda yetarli emas`, false); }),
          h('div', { class: 'sc-sum' }, money(p.price * n)));
      }) : h('p', { class: 'mute sc-empty' }, 'Mahsulot shtrixkodini ramkaga to\'g\'rilang')),
      h('div', { class: 'sc-foot' }, h('div', {}, h('div', { class: 'mute' }, `${cart.size} xil · ${qf(qty)} dona${c.discount ? ' · chegirma bilan' : ''}`), h('div', { class: 'total' }, money(c.total))),
        h('button', { class: 'btn sc-sell', disabled: !cart.size, onclick: async () => {
          const r = await sell();
          if (r.ok) state.scanner?.close(); else state.scanner?.notify(r.msg, false);
        } }, 'Sotish')));
  };
  const startScan = () => {
    state.scanner = openScanner({
      title: 'Skanerlab sotish', panel: scanPanel,
      onClose: () => { state.scanner = null; drawCart(); drawList(); },
      onCode: async (code) => {
        const p = products.find((x) => x.sku === code);
        if (!p) return { ok: false, msg: `Topilmadi: ${code}` };
        const have = cart.get(p.id) || 0;
        if (have + 1 > p.stock) return { ok: false, msg: `"${p.name}" omborda yetarli emas (${qf(p.stock)})` };
        cart.set(p.id, have + 1); drawCart(p.id);
        return { ok: true, msg: `✓ ${p.name} — ${have + 1} ta` };
      } });
    drawScanPanel();
  };
  q.addEventListener('keydown', (e) => { // klaviatura-skaner SKU ni yozib Enter bosadi
    if (e.key !== 'Enter') return;
    const code = q.value.trim(); const exact = products.find((p) => p.sku && p.sku === code);
    const hit = exact || (matches().length === 1 ? matches()[0] : null);
    if (hit) { addToCart(hit); q.value = ''; drawList(); } else flash(box, 'Mahsulot topilmadi: ' + code);
  });
  const calc = () => {
    let subtotal = 0; const ls = [];
    for (const [id, n] of cart) { const p = byId.get(id); const total = Math.round(p.price * n); subtotal += total; ls.push({ id, name: p.name, qty: n, total }); }
    const dv = Number(dVal.value) || 0;
    const discount = Math.min(subtotal, dType.value === 'percent' ? Math.round(subtotal * Math.min(dv, 100) / 100) : Math.round(dv));
    const total = subtotal - discount;
    const pd = paid.value === '' ? total : Math.min(Math.round(Number(paid.value) || 0), total);
    return { ls, subtotal, discount, total, pd };
  };
  const drawCart = (flashId) => {
    const c = calc();
    if (state.scanner) drawScanPanel(flashId);
    cartEl.replaceChildren(cart.size ? table(['Mahsulot', 'Miqdor', 'Summa', ''], [...cart].map(([id, n]) => {
      const p = byId.get(id);
      const inp = h('input', { type: 'number', min: 0, step: 'any', value: n, onchange: () => { const v = Number(inp.value); v > 0 ? cart.set(id, Math.min(v, p.stock)) : cart.delete(id); drawCart(); } });
      return [p.name, inp, money(p.price * n), h('button', { class: 'btn sec', onclick: () => { cart.delete(id); drawCart(); } }, '✕')];
    }), [2]) : h('p', { class: 'mute' }, "Savat bo'sh"));
    sumEl.replaceChildren(...[
      c.discount ? h('div', { class: 'mute' }, `Jami: ${money(c.subtotal)} − chegirma ${money(c.discount)}`) : null,
      c.pd < c.total ? h('div', { class: 'tag low' }, `Nasiya: ${money(c.total - c.pd)}${cust.value ? '' : ' — mijozni tanlang'}`) : null,
      h('div', { class: 'total' }, money(c.total))].filter(Boolean));
  };
  const sell = async () => {
    const c = calc();
    try {
      const r = await post('/api/sales', { method: method.value, customer_id: cust.value || null, discount: Number(dVal.value) || 0, discount_type: dType.value,
        paid: paid.value === '' ? null : Number(paid.value), items: [...cart].map(([product_id, qty]) => ({ product_id, qty })) });
      flash(box, `Sotuv #${r.id} saqlandi: ${money(r.total)}`, 'ok');
      for (const [id, n] of cart) byId.get(id).stock -= n;
      const receipt = { ...r, lines: c.ls };
      lastEl.replaceChildren(h('button', { class: 'btn sec', onclick: () => printReceipt(receipt) }, '🖨 Chekni chop etish'));
      cart.clear(); dVal.value = 0; paid.value = ''; drawCart(); drawList();
      return { ok: true };
    } catch (e) { flash(box, e.message); return { ok: false, msg: e.message }; }
  };
  q.addEventListener('input', drawList); drawList(); drawCart();
  return h('div', {}, h('button', { class: 'btn scanbtn scanhero', onclick: startScan }, '📷 Skanerlab sotish'), h('div', { class: 'cols' },
    h('div', { class: 'card' }, h('h3', {}, 'Mahsulot tanlash'), h('div', { class: 'row' }, h('button', { class: 'btn scanbtn', onclick: startScan }, '📷 Skaner'), q), list),
    h('div', { class: 'card' }, h('h3', {}, 'Savat'), box, cartEl,
      h('div', { class: 'row' }, h('span', { class: 'mute' }, 'Chegirma:'), dVal, dType, cust),
      h('div', { class: 'row' }, h('span', { class: 'mute' }, "To'lov:"), paid, method),
      h('div', { class: 'checkout' }, sumEl, h('button', { class: 'btn', style: 'width:100%', onclick: sell }, 'Sotish')), h('div', { style: 'margin-top:8px' }, lastEl))));
}

// ---------- Kirim (sotuvchi va admin) ----------
async function receiptView() {
  const [products, suppliers] = await Promise.all([get('/api/products'), get('/api/suppliers')]);
  const isAdmin = state.user.role === 'admin';
  const lines = []; const box = msgBox(), area = h('div'), hist = h('div');
  const sup = h('select', {}, h('option', { value: '' }, '— Yetkazib beruvchi —'), suppliers.map((s) => h('option', { value: s.id }, s.name)));
  const newSup = h('input', { placeholder: 'Yangi yetkazib beruvchi' });
  const prod = h('select', {}, products.map((p) => h('option', { value: p.id }, p.name)));
  const note = h('input', { placeholder: 'Izoh (ixtiyoriy)', style: 'flex:1' });
  const draw = () => area.replaceChildren(lines.length ? table(['Mahsulot', 'Miqdor', isAdmin ? 'Tannarx' : 'Kirim narxi', ''], lines.map((l, i) => [
    l.name,
    h('input', { type: 'number', min: 0, step: 'any', value: l.qty, onchange: (e) => { l.qty = Number(e.target.value); } }),
    h('input', { type: 'number', min: 0, value: l.cost, onchange: (e) => { l.cost = Number(e.target.value); } }),
    h('button', { class: 'btn sec', onclick: () => { lines.splice(i, 1); draw(); } }, '✕')]), [1, 2]) : h('p', { class: 'mute' }, "Mahsulot qo'shing"));
  const scanPanel = h('div', { class: 'scan-cart' });
  const drawScanPanel = (flashId) => {
    const qty = lines.reduce((a, l) => a + l.qty, 0);
    scanPanel.replaceChildren(
      h('div', { class: 'sc-list' }, lines.length ? [...lines].reverse().map((l) => h('div', { class: 'sc-row' + (l.id === flashId ? ' new' : '') },
        h('div', { class: 'sc-name' }, h('b', {}, l.name), h('span', { class: 'mute' }, 'kirim narxi:'),
          h('input', { class: 'sc-cost', type: 'number', min: 0, value: l.cost, onchange: (e) => { l.cost = Number(e.target.value); } })),
        stepper(l.qty, () => { l.qty = Math.max(0, l.qty - 1); if (!l.qty) lines.splice(lines.indexOf(l), 1); drawScanPanel(); }, () => { l.qty += 1; drawScanPanel(); }),
        h('div', { class: 'sc-sum' }, money(l.cost * l.qty)))) : h('p', { class: 'mute sc-empty' }, 'Kelgan mahsulot shtrixkodini skanerlang')),
      h('div', { class: 'sc-foot' }, h('div', {}, h('div', { class: 'mute' }, `${lines.length} xil · ${qf(qty)} dona`), h('div', { class: 'total' }, money(lines.reduce((a, l) => a + l.cost * l.qty, 0)))),
        h('button', { class: 'btn sc-sell', onclick: () => state.scanner?.close() }, 'Tayyor')));
  };
  const startScan = () => {
    state.scanner = openScanner({
      title: 'Kirim: skanerlash', panel: scanPanel,
      onClose: () => { state.scanner = null; draw(); },
      onCode: async (code) => {
        const p = products.find((x) => x.sku === code);
        if (!p) return { ok: false, msg: `Topilmadi: ${code}` };
        let l = lines.find((x) => x.id === p.id);
        if (l) l.qty += 1; else { l = { id: p.id, name: p.name, qty: 1, cost: p.cost || 0 }; lines.push(l); }
        drawScanPanel(p.id);
        return { ok: true, msg: `✓ ${p.name} — ${qf(l.qty)} ta` };
      } });
    drawScanPanel();
  };
  const add = () => { const p = products.find((x) => x.id === Number(prod.value)); if (p && !lines.some((l) => l.id === p.id)) lines.push({ id: p.id, name: p.name, qty: 1, cost: p.cost || 0 }); draw(); };
  const loadHist = async () => {
    const rows = await get('/api/receipts?date=' + today());
    const reversed = new Set(rows.filter((r) => r.kind === 'reversal').map((r) => r.ref_receipt_id));
    hist.replaceChildren(rows.length ? table(['№', 'Vaqt', 'Yetkazuvchi', 'Mahsulotlar', 'Summa'].concat(isAdmin ? [''] : []), rows.map((r) => [r.id, hhmm(r.created_at), r.supplier || '—',
      r.kind === 'reversal' ? h('span', { class: 'tag low' }, 'Storno: ' + r.items) : r.items, money(r.total)].concat(isAdmin ? [r.kind === 'receipt' && !reversed.has(r.id) ? h('button', { class: 'btn sec', onclick: async () => {
        if (!confirm(`Kirim #${r.id} storno qilinsinmi? Tovar ombordan ayriladi, asl hujjat saqlanadi.`)) return;
        try { await post(`/api/admin/receipts/${r.id}/reverse`); flash(box, 'Storno hujjati yaratildi', 'ok'); loadHist(); } catch (e) { flash(box, e.message); }
      } }, 'Storno') : (r.kind === 'receipt' ? h('span', { class: 'mute' }, 'storno qilingan') : '')] : [])), [4]) : h('p', { class: 'mute' }, 'Bugun kirim yo\'q'));
  };
  const addSup = async () => {
    if (!newSup.value.trim()) return;
    try { const r = await post('/api/suppliers', { name: newSup.value }); const o = h('option', { value: r.id }, newSup.value); sup.append(o); sup.value = r.id; newSup.value = ''; } catch (e) { flash(box, e.message); }
  };
  const save = async () => {
    try {
      const r = await post('/api/receipts', { supplier_id: sup.value || null, note: note.value, items: lines.map((l) => ({ product_id: l.id, qty: l.qty, cost: l.cost })) });
      flash(box, `Kirim #${r.id} saqlandi: ${money(r.total)}`, 'ok'); lines.length = 0; draw(); loadHist();
    } catch (e) { flash(box, e.message); }
  };
  draw(); loadHist();
  return h('div', {}, h('div', { class: 'card' }, h('h3', {}, 'Yangi kirim'), box,
    h('div', { class: 'row' }, sup, newSup, h('button', { class: 'btn sec', onclick: addSup }, "Qo'shish")),
    h('div', { class: 'row' }, prod, h('button', { class: 'btn sec', onclick: add }, "+ Mahsulot"), h('button', { class: 'btn', onclick: startScan }, '📷 Skaner')), area,
    h('div', { class: 'row', style: 'margin-top:10px' }, note, h('button', { class: 'btn', onclick: save }, 'Kirim qilish'))),
    h('div', { class: 'card' }, h('h3', {}, 'Bugungi kirimlar'), hist));
}

// ---------- Ombor (ikkala rol; admin tahrirlay oladi) ----------
async function stockView() {
  const isAdmin = state.user.role === 'admin';
  let status = 'active';
  let products = await get('/api/products');
  const reload = async () => { products = await get('/api/products' + (isAdmin ? '?status=' + status : '')); draw(); };
  const out = h('div'), box = msgBox();
  const q = h('input', { placeholder: 'Qidirish...' });
  const only = h('select', {}, h('option', { value: '' }, 'Barcha qoldiq'), h('option', { value: 'low' }, 'Faqat kam qolganlar'));
  const st = h('select', { onchange: (e) => { status = e.target.value; reload(); } }, STATUS_OPTS());
  const draw = () => {
    const s = q.value.toLowerCase();
    const rows = products.filter((p) => (!s || p.name.toLowerCase().includes(s) || (p.category || '').toLowerCase().includes(s) || (p.sku || '').toLowerCase().includes(s)) && (!only.value || p.stock <= p.min_stock));
    const head = ['Mahsulot', 'Kategoriya', 'Qoldiq', 'Min.', 'Narx', 'Holat'].concat(isAdmin ? ['Tannarx', 'Status', ''] : []);
    out.replaceChildren(table(head, rows.map((p) => [p.name, p.category, `${qf(p.stock)} ${p.unit}`, qf(p.min_stock), fmt(p.price), stockTag(p)]
      .concat(isAdmin ? [fmt(p.cost), activeTag(p.active), h('span', { class: 'row', style: 'margin:0' }, h('button', { class: 'btn sec', onclick: () => edit(p) }, 'Tahrir'), h('button', { class: 'btn sec', onclick: () => setStatus(p) }, p.active ? 'Noaktiv qilish' : 'Faollashtirish'))] : [])), [2, 3, 4, 6]));
  };
  const setStatus = async (p) => {
    if (p.active && !confirm(`"${p.name}" noaktiv qilinsinmi? Ma'lumot o'chirilmaydi, lekin yangi sotuv/kirimda ishlatib bo'lmaydi.`)) return;
    try { await post(`/api/products/${p.id}/status`, { active: !p.active }); flash(box, p.active ? 'Noaktiv qilindi' : 'Faollashtirildi', 'ok'); reload(); } catch (e) { flash(box, e.message); }
  };
  const form = h('div');
  const edit = (p) => {
    const f = { name: p?.name || '', sku: p?.sku || '', category: p?.category || '', unit: p?.unit || 'dona', price: p?.price || 0, cost: p?.cost || 0, min_stock: p?.min_stock || 0, stock: 0 };
    const field = (k, label, type = 'text') => h('label', { class: 'mute' }, label, h('br'), h('input', { type, step: 'any', value: f[k], oninput: (e) => { f[k] = type === 'number' ? Number(e.target.value) : e.target.value; } }));
    form.replaceChildren(h('div', { class: 'card' }, h('h3', {}, p ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot'),
      h('div', { class: 'row' }, field('name', 'Nomi'), field('sku', 'SKU'), field('category', 'Kategoriya'), field('unit', 'Birlik')),
      h('div', { class: 'row' }, field('price', 'Sotuv narxi', 'number'), field('cost', 'Tannarx', 'number'), field('min_stock', 'Minimal qoldiq', 'number'), p ? null : field('stock', 'Boshlang\'ich qoldiq', 'number')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
        try { p ? await api('PUT', '/api/products/' + p.id, f) : await post('/api/products', f); form.replaceChildren(); await reload(); flash(box, 'Saqlandi', 'ok'); } catch (e) { flash(box, e.message); }
      } }, 'Saqlash'), h('button', { class: 'btn sec', onclick: () => form.replaceChildren() }, 'Bekor'),
      null)));
    form.scrollIntoView({ behavior: 'smooth' });
  };
  q.addEventListener('input', draw); only.addEventListener('change', draw); draw();
  return h('div', {}, box, form, h('div', { class: 'card' }, h('div', { class: 'row' }, q, only, isAdmin ? st : null, isAdmin ? h('button', { class: 'btn', onclick: () => edit(null) }, "+ Yangi mahsulot") : null), out));
}

// ---------- Sotuvchi: bugungi sotuvlar ----------
async function mySalesView() {
  const rows = await get('/api/sales?date=' + today());
  const sum = rows.reduce((a, r) => a + r.total, 0);
  return h('div', { class: 'card' }, h('h3', {}, `Bugungi sotuvlarim: ${rows.length} ta, ${money(sum)}`),
    rows.length ? table(['№', 'Vaqt', 'Mahsulotlar', 'To\'lov', 'Summa'], rows.map((r) => [r.id, hhmm(r.created_at), r.kind === 'return' ? h('span', { class: 'tag low' }, 'Qaytarish: ' + r.items) : r.items, { cash: 'Naqd', card: 'Karta', transfer: "O'tkazma" }[r.method], money(r.total)]), [4]) : h('p', { class: 'mute' }, 'Hali sotuv yo\'q'));
}

// ---------- Admin: dashboard ----------
async function dashboardView() {
  let date = today(), days = 30, pid = '';
  const wrap = h('div');
  const products = await get('/api/products');
  const load = async () => {
    const pq = pid ? '&product_id=' + pid : '';
    const [sum, hourly, daily, top, sellers] = await Promise.all([
      get('/api/admin/summary?date=' + date), get(`/api/admin/hourly?date=${date}${pq}`),
      get(`/api/admin/daily?from=${addDays(date, -days + 1)}&to=${date}${pq}`),
      get(`/api/admin/top-products?from=${addDays(date, -days + 1)}&to=${date}`), get(`/api/admin/sellers?from=${addDays(date, -days + 1)}&to=${date}`)]);
    const delta = (a, b) => { if (!b) return h('span', { class: 'mute' }, 'kecha: 0'); const p = Math.round((a / b - 1) * 100); return h('span', { class: p >= 0 ? 'up' : 'down' }, `${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}% kechaga nisbatan`); };
    const kpi = (l, v, d) => h('div', { class: 'card kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), h('div', { class: 'd' }, d || ''));
    const t = sum.today, y = sum.yesterday, inv = sum.inventory;
    const peak = hourly.hours.reduce((a, b) => (b.revenue > a.revenue ? b : a));
    wrap.replaceChildren(
      h('div', { class: 'grid' }, kpi('Tushum', money(t.revenue), delta(t.revenue, y.revenue)), kpi('Foyda', money(t.profit), delta(t.profit, y.profit)),
        kpi('Cheklar', fmt(t.orders), delta(t.orders, y.orders)), kpi('Ombor qiymati (tannarx)', money(inv.cost_value), `${inv.products} ta mahsulot, ${inv.low || 0} tasi kam`),
        kpi('Nasiya (qarzlar)', money(sum.debt.total), `${sum.debt.customers} ta mijoz`)),
      h('div', { class: 'card' }, h('h3', {}, `Soatma-soat tushum — ${date}${pid ? ' (tanlangan mahsulot)' : ''}`), barChart(hourly.hours, { label: (x) => String(x.hour).padStart(2, '0'), value: (x) => x.revenue }),
        h('p', { class: 'mute' }, peak.revenue ? `Eng gavjum soat: ${String(peak.hour).padStart(2, '0')}:00 (${money(peak.revenue)})` : 'Bu kunda sotuv yo\'q')),
      h('div', { class: 'card' }, h('h3', {}, `Kunma-kun tushum — oxirgi ${days} kun`), barChart(daily.days, { label: (x) => x.day.slice(5), value: (x) => x.revenue })),
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h3', {}, 'Eng ko\'p sotilgan mahsulotlar'), table(['Mahsulot', 'Miqdor', 'Tushum', 'Foyda', 'Qoldiq'], top.slice(0, 10).map((p) => [p.name, qf(p.qty), fmt(p.revenue), fmt(p.profit), `${qf(p.stock)} ${p.unit}`]), [1, 2, 3, 4])),
        h('div', { class: 'card' }, h('h3', {}, 'Sotuvchilar'), table(['Ism', 'Cheklar', 'Tushum'], sellers.map((s) => [s.name, s.orders, fmt(s.revenue)]), [1, 2]))));
  };
  const d = h('input', { type: 'date', value: date, max: today(), onchange: (e) => { date = e.target.value || today(); load(); } });
  const r = h('select', { onchange: (e) => { days = Number(e.target.value); load(); } }, [7, 14, 30, 90].map((n) => h('option', { value: n, selected: n === days }, `${n} kun`)));
  const ps = h('select', { onchange: (e) => { pid = e.target.value; load(); } }, h('option', { value: '' }, 'Barcha mahsulotlar'), products.map((p) => h('option', { value: p.id }, p.name)));
  await load();
  return h('div', {}, h('div', { class: 'row' }, d, r, ps), wrap);
}

// ---------- Admin: xarid takliflari ----------
async function offersView() {
  let offers = await get('/api/admin/offers'); const suppliers = await get('/api/suppliers');
  const box = msgBox(), out = h('div'); const pick = new Map();
  offers.forEach((o) => pick.set(o.product_id, { on: o.urgency !== 'low', qty: o.suggested_qty, cost: o.cost }));
  const U = { out: 'Tugagan', critical: 'Shoshilinch', low: 'Kam' };
  const draw = () => {
    if (!offers.length) return out.replaceChildren(h('p', { class: 'mute' }, 'Hozircha xarid kerak bo\'lgan mahsulot yo\'q ✅'));
    const groups = new Map(); offers.forEach((o) => { const k = o.supplier_id ?? 0; groups.set(k, [...(groups.get(k) || []), o]); });
    out.replaceChildren(...[...groups].map(([sid, items]) => {
      const sel = items.filter((o) => pick.get(o.product_id).on);
      const total = sel.reduce((a, o) => a + pick.get(o.product_id).qty * pick.get(o.product_id).cost, 0);
      const supSel = h('select', {}, h('option', { value: '' }, '— tanlanmagan —'), suppliers.map((s) => h('option', { value: s.id, selected: s.id === sid }, s.name)));
      return h('div', { class: 'card' }, h('h3', {}, sid ? 'Yetkazib beruvchi: ' + items[0].supplier : 'Yetkazib beruvchi aniqlanmagan'),
        table(['', 'Mahsulot', 'Qoldiq', 'Kunlik sotuv', 'Yetadi', 'Holat', 'Buyurtma miqdori', 'Narx'], items.map((o) => {
          const pk = pick.get(o.product_id);
          return [h('input', { type: 'checkbox', checked: pk.on, onchange: (e) => { pk.on = e.target.checked; draw(); } }), o.name, `${qf(o.stock)} ${o.unit}`, o.avg_daily,
            o.days_left === null ? '—' : `${o.days_left} kun`, h('span', { class: 'tag ' + o.urgency }, U[o.urgency]),
            h('input', { type: 'number', min: 1, step: 'any', value: pk.qty, onchange: (e) => { pk.qty = Number(e.target.value); draw(); } }),
            h('input', { type: 'number', min: 0, value: pk.cost, onchange: (e) => { pk.cost = Number(e.target.value); draw(); } })];
        }), [2, 3, 4, 6, 7]),
        h('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px' }, h('span', { class: 'total' }, money(total)),
          h('span', { class: 'row' }, supSel, h('button', { class: 'btn', disabled: !sel.length, onclick: async () => {
            try {
              const r = await post('/api/admin/purchase-orders', { supplier_id: supSel.value || null, items: sel.map((o) => ({ product_id: o.product_id, qty: pick.get(o.product_id).qty, cost: pick.get(o.product_id).cost })) });
              flash(box, `Buyurtma #${r.id} yaratildi (${money(r.total)})`, 'ok'); offers = await get('/api/admin/offers'); draw();
            } catch (e) { flash(box, e.message); }
          } }, 'Buyurtma yaratish'))));
    }));
  };
  draw();
  return h('div', {}, h('div', { class: 'card' }, h('h3', {}, 'Kam qolgan mahsulotlar bo\'yicha xarid taklifi'),
    h('p', { class: 'mute' }, 'Oxirgi 30 kunlik sotuv tezligi asosida 14 kunga yetadigan miqdor hisoblanadi. Allaqachon buyurtma qilingan miqdor hisobga olinadi.')), box, out);
}

async function ordersView() {
  const box = msgBox(); const out = h('div');
  const S = { ordered: 'Yo\'lda', received: 'Qabul qilingan', cancelled: 'Bekor' };
  const load = async () => {
    const os = await get('/api/admin/purchase-orders');
    out.replaceChildren(os.length ? os.map((o) => h('div', { class: 'card' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, `Buyurtma #${o.id} · ${o.supplier || 'yetkazib beruvchisiz'}`), h('span', { class: 'tag ' + o.status }, S[o.status])),
      h('div', { class: 'mute' }, hhmm(o.created_at) + (o.supplier_phone ? ' · ' + o.supplier_phone : '')),
      table(['Mahsulot', 'Miqdor', 'Narx'], o.items.map((i) => [i.name, `${qf(i.qty)} ${i.unit}`, fmt(i.cost)]), [1, 2]),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px' }, h('span', { class: 'total' }, money(o.total)),
        o.status === 'ordered' ? h('span', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => { try { await post(`/api/admin/purchase-orders/${o.id}/receive`); load(); } catch (e) { flash(box, e.message); } } }, 'Qabul qilindi → omborga kirim'),
          h('button', { class: 'btn sec', onclick: async () => { try { await post(`/api/admin/purchase-orders/${o.id}/cancel`); load(); } catch (e) { flash(box, e.message); } } }, 'Bekor')) : null))) : h('p', { class: 'mute' }, 'Buyurtmalar yo\'q'));
  };
  await load(); return h('div', {}, box, out);
}

async function salesHistoryView() {
  let date = today(); const out = h('div');
  const load = async () => {
    const rows = await get('/api/sales?date=' + date);
    out.replaceChildren(rows.length ? table(['№', 'Vaqt', 'Sotuvchi', 'Mahsulotlar', 'Summa'], rows.map((r) => [r.id, hhmm(r.created_at), r.seller, r.kind === 'return' ? h('span', { class: 'tag low' }, 'Qaytarish: ' + r.items) : [r.items, r.customer ? ' · ' + r.customer : '', r.discount ? ` · chegirma ${fmt(r.discount)}` : ''].join(''), money(r.total)]), [4]) : h('p', { class: 'mute' }, 'Sotuv yo\'q'));
  };
  await load();
  return h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', {}, 'Sotuvlar tarixi'), h('input', { type: 'date', value: date, onchange: (e) => { date = e.target.value; load(); } })), out);
}

async function usersView() {
  const box = msgBox(), out = h('div'); const f = { username: '', name: '', password: '', role: 'seller' };
  const load = async () => {
    const us = await get('/api/admin/users');
    out.replaceChildren(table(['Login', 'Ism', 'Rol', 'Holat', ''], us.map((u) => [u.username, u.name, u.role === 'admin' ? 'Admin' : 'Sotuvchi', activeTag(u.active),
      h('span', { class: 'row' }, h('button', { class: 'btn sec', onclick: async () => { try { await api('PUT', '/api/admin/users/' + u.id, { active: !u.active }); load(); } catch (e) { flash(box, e.message); } } }, u.active ? 'Noaktiv qilish' : 'Faollashtirish'),
        h('button', { class: 'btn sec', onclick: async () => { const pw = prompt('Yangi parol (kamida 6 belgi)'); if (pw) try { await api('PUT', '/api/admin/users/' + u.id, { password: pw }); flash(box, 'Parol almashtirildi', 'ok'); } catch (e) { flash(box, e.message); } } }, 'Parol'))])));
  };
  const inp = (k, ph, type = 'text') => h('input', { placeholder: ph, type, oninput: (e) => { f[k] = e.target.value; } });
  await load();
  return h('div', {}, box, h('div', { class: 'card' }, h('h3', {}, 'Yangi foydalanuvchi'), h('div', { class: 'row' }, inp('username', 'Login'), inp('name', 'Ism'), inp('password', 'Parol', 'password'),
    h('select', { onchange: (e) => { f.role = e.target.value; } }, h('option', { value: 'seller' }, 'Sotuvchi'), h('option', { value: 'admin' }, 'Admin')),
    h('button', { class: 'btn', onclick: async () => { try { await post('/api/admin/users', f); flash(box, 'Qo\'shildi', 'ok'); load(); } catch (e) { flash(box, e.message); } } }, "Qo'shish"))),
    h('div', { class: 'card' }, out));
}

// ---------- Qaytarish ----------
async function returnsView() {
  let date = today(); const list = h('div'), form = h('div'), box = msgBox();
  const open = async (id) => {
    const s = await get('/api/sales/' + id);
    const qty = new Map(); const refund = h('select', {}, h('option', { value: 'cash' }, 'Naqd qaytariladi'), s.customer_id ? h('option', { value: 'debt' }, 'Mijoz qarziga o\'tkaziladi') : null);
    form.replaceChildren(h('div', { class: 'card' }, h('h3', {}, `Sotuv #${s.id} — ${hhmm(s.created_at)}${s.customer ? ' · ' + s.customer : ''}`),
      table(['Mahsulot', 'Sotilgan', 'Qaytarish mumkin', 'Qaytarish'], s.items.map((i) => [i.name, `${qf(i.qty)} ${i.unit}`, qf(i.returnable),
        h('input', { type: 'number', min: 0, max: i.returnable, step: 'any', value: 0, disabled: i.returnable <= 0, oninput: (e) => qty.set(i.id, Number(e.target.value)) })]), [1, 2]),
      h('div', { class: 'row', style: 'margin-top:10px' }, refund, h('button', { class: 'btn', onclick: async () => {
        try {
          const r = await post('/api/returns', { sale_id: s.id, refund: refund.value, items: [...qty].map(([sale_item_id, q]) => ({ sale_item_id, qty: q })) });
          flash(box, `Qaytarish #${r.id}: ${money(r.total)} (qarzga: ${money(r.to_debt)}, naqd: ${money(r.cash_refund)})`, 'ok'); form.replaceChildren(); load();
        } catch (e) { flash(box, e.message); }
      } }, 'Qaytarishni tasdiqlash'), h('button', { class: 'btn sec', onclick: () => form.replaceChildren() }, 'Bekor'))));
  };
  const load = async () => {
    const rows = (await get('/api/sales?date=' + date)).filter((r) => r.kind === 'sale');
    list.replaceChildren(rows.length ? table(['№', 'Vaqt', 'Mahsulotlar', 'Summa', ''], rows.map((r) => [r.id, hhmm(r.created_at), r.items, money(r.total),
      h('button', { class: 'btn sec', onclick: () => open(r.id).catch((e) => flash(box, e.message)) }, 'Qaytarish')]), [3]) : h('p', { class: 'mute' }, 'Sotuv yo\'q'));
  };
  await load();
  return h('div', {}, box, form, h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', {}, 'Qaytariladigan sotuvni tanlang'),
    h('input', { type: 'date', value: date, max: today(), onchange: (e) => { date = e.target.value; load(); } })), list));
}

// ---------- Mijozlar va nasiya ----------
async function customersView() {
  const isAdmin = state.user.role === 'admin';
  const box = msgBox(), out = h('div'); const f = { name: '', phone: '' }; let status = 'active';
  const load = async () => {
    const cs = await get('/api/customers' + (isAdmin ? '?status=' + status : ''));
    out.replaceChildren(cs.length ? table(['Mijoz', 'Telefon', 'Qarz'].concat(isAdmin ? ['Status'] : []).concat(['']), cs.map((c) => [c.name, c.phone, c.balance ? h('b', {}, money(c.balance)) : '—']
      .concat(isAdmin ? [activeTag(c.active)] : [])
      .concat([h('span', { class: 'row', style: 'margin:0' }, c.balance ? h('button', { class: 'btn sec', onclick: async () => {
        const v = prompt(`${c.name}: to'lov summasi (qarz ${fmt(c.balance)})`, c.balance); if (!v) return;
        try { await post(`/api/customers/${c.id}/payments`, { amount: Number(v) }); flash(box, "To'lov qabul qilindi", 'ok'); load(); } catch (e) { flash(box, e.message); }
      } }, "To'lov qabul qilish") : null,
      isAdmin ? h('button', { class: 'btn sec', onclick: async () => {
        if (c.active && !confirm(`"${c.name}" noaktiv qilinsinmi? Ma'lumot o'chirilmaydi.`)) return;
        try { await post(`/api/customers/${c.id}/status`, { active: !c.active }); load(); } catch (e) { flash(box, e.message); }
      } }, c.active ? 'Noaktiv qilish' : 'Faollashtirish') : null)])), [2]) : h('p', { class: 'mute' }, 'Mijozlar yo\'q'));
  };
  const inp = (k, ph) => h('input', { placeholder: ph, oninput: (e) => { f[k] = e.target.value; } });
  await load();
  return h('div', {}, box, h('div', { class: 'card' }, h('h3', {}, 'Yangi mijoz'), h('div', { class: 'row' }, inp('name', 'Ism'), inp('phone', 'Telefon'),
    h('button', { class: 'btn', onclick: async () => { try { await post('/api/customers', f); flash(box, "Qo'shildi", 'ok'); load(); } catch (e) { flash(box, e.message); } } }, "Qo'shish"))),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', {}, 'Nasiya (qarzdorlar)'), isAdmin ? h('select', { onchange: (e) => { status = e.target.value; load(); } }, STATUS_OPTS()) : null), out));
}

// ---------- Admin: yetkazib beruvchilar ----------
async function suppliersView() {
  const box = msgBox(), out = h('div'); const f = { name: '', phone: '' }; let status = 'active';
  const load = async () => {
    const ss = await get('/api/suppliers?status=' + status);
    out.replaceChildren(ss.length ? table(['Nomi', 'Telefon', 'Status', ''], ss.map((x) => [x.name, x.phone, activeTag(x.active),
      h('button', { class: 'btn sec', onclick: async () => {
        if (x.active && !confirm(`"${x.name}" noaktiv qilinsinmi? Ma'lumot o'chirilmaydi.`)) return;
        try { await post(`/api/suppliers/${x.id}/status`, { active: !x.active }); load(); } catch (e) { flash(box, e.message); }
      } }, x.active ? 'Noaktiv qilish' : 'Faollashtirish')])) : h('p', { class: 'mute' }, 'Yetkazib beruvchilar yo\'q'));
  };
  const inp = (k, ph) => h('input', { placeholder: ph, oninput: (e) => { f[k] = e.target.value; } });
  await load();
  return h('div', {}, box, h('div', { class: 'card' }, h('h3', {}, 'Yangi yetkazib beruvchi'), h('div', { class: 'row' }, inp('name', 'Nomi'), inp('phone', 'Telefon'),
    h('button', { class: 'btn', onclick: async () => { try { await post('/api/suppliers', f); flash(box, "Qo'shildi", 'ok'); load(); } catch (e) { flash(box, e.message); } } }, "Qo'shish"))),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', {}, 'Yetkazib beruvchilar'), h('select', { onchange: (e) => { status = e.target.value; load(); } }, STATUS_OPTS())), out));
}

// ---------- Admin: o'zgarishlar tarixi (audit) ----------
async function auditView() {
  let tbl = '';
  const out = h('div');
  const T = { products: 'Mahsulot', customers: 'Mijoz', suppliers: 'Yetkazib beruvchi', users: 'Foydalanuvchi', purchase_orders: 'Buyurtma' };
  const F = { price: 'Narx', cost: 'Tannarx', name: 'Nomi', sku: 'SKU', category: 'Kategoriya', unit: 'Birlik', min_stock: 'Min. qoldiq', active: 'Holat', phone: 'Telefon', role: 'Rol', username: 'Login', password_hash: 'Parol', status: 'Status', supplier_id: 'Yetkazuvchi' };
  const val = (f, v) => f === 'active' ? (v === 'true' ? 'Aktiv' : 'Noaktiv') : v;
  const load = async () => {
    const rows = await get('/api/admin/change-log' + (tbl ? '?table=' + tbl : ''));
    out.replaceChildren(rows.length ? table(['Vaqt', 'Kim', 'Obyekt', 'Amal', 'Eski → Yangi'], rows.map((r) => [hhmm(r.created_at), r.user || '—', `${T[r.table_name] || r.table_name}: ${r.label || '#' + r.record_id}`,
      r.action === 'I' ? 'Yaratildi' : F[r.field] || r.field, r.action === 'I' ? '' : `${val(r.field, r.old_value) ?? '—'} → ${val(r.field, r.new_value) ?? '—'}`])) : h('p', { class: 'mute' }, 'Tarix bo\'sh'));
  };
  await load();
  return h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', {}, "O'zgarishlar tarixi"),
    h('select', { onchange: (e) => { tbl = e.target.value; load(); } }, h('option', { value: '' }, 'Hammasi'), Object.entries(T).map(([k, v]) => h('option', { value: k }, v)))),
    h('p', { class: 'mute' }, "Ma'lumotlar hech qachon o'chirilmaydi: faqat noaktiv qilinadi. Hujjatlar (sotuv, kirim) o'zgarmaydi — qaytarish/storno bilan tuzatiladi."), out);
}

const TABS = {
  seller: [['sell', 'Sotuv', sellView], ['receipt', 'Kirim', receiptView], ['stock', 'Ombor', stockView], ['returns', 'Qaytarish', returnsView], ['cust', 'Mijozlar', customersView], ['mine', 'Sotuvlarim', mySalesView]],
  admin: [['dash', 'Tahlil', dashboardView], ['stock', 'Ombor', stockView], ['offers', 'Xarid takliflari', offersView], ['orders', 'Buyurtmalar', ordersView],
    ['receipt', 'Kirim', receiptView], ['sales', 'Sotuvlar', salesHistoryView], ['returns', 'Qaytarish', returnsView], ['cust', 'Mijozlar', customersView], ['sup', 'Yetkazuvchilar', suppliersView], ['audit', 'Tarix', auditView], ['users', 'Foydalanuvchilar', usersView]],
};

async function render() {
  state.scanner?.close();
  if (!state.user) { root.replaceChildren(loginView()); return; }
  const tabs = TABS[state.user.role]; state.tab ||= tabs[0][0];
  const main = h('main', {}, h('p', { class: 'mute' }, 'Yuklanmoqda...'));
  root.replaceChildren(h('header', {}, h('b', {}, 'Mini ERP'),
    h('nav', {}, tabs.map(([k, label]) => h('button', { class: k === state.tab ? 'on' : '', onclick: () => { state.tab = k; render(); } }, label))), h('span', { class: 'sp' }),
    h('span', { class: 'mute who' }, `${state.user.name} (${state.user.role === 'admin' ? 'admin' : 'sotuvchi'})`),
    h('button', { class: 'btn sec', onclick: async () => { await post('/api/logout').catch(() => {}); state.user = null; render(); } }, 'Chiqish')), main);
  try { main.replaceChildren(await tabs.find((t) => t[0] === state.tab)[2]()); }
  catch (e) { main.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
}

get('/api/me').then((u) => { state.user = u; }).catch(() => {}).finally(render);
