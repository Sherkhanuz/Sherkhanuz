// Mini ERP — mijoz tomoni (vanilla JS, DOM orqali; matn har doim textContent bilan qo'yiladi)
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
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
const hhmm = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'erp' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { state.user = null; render(); throw new Error(data.error); }
  if (!r.ok) throw new Error(data.error || 'Xato');
  return data;
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b || {});

const state = { user: null, tab: null };
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
function flash(box, text, kind = 'err') { box.replaceChildren(text ? h('div', { class: 'msg ' + kind }, text) : ''); }
const table = (head, rows, numCols = []) => h('div', { class: 'wrap' }, h('table', {},
  h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: numCols.includes(i) ? 'n' : '' }, t)))),
  h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numCols.includes(i) ? 'n' : '' }, c)))))));
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
async function sellView() {
  const products = await get('/api/products');
  const cart = new Map(); // id -> qty
  const box = msgBox(), list = h('div', { class: 'pick' }), cartEl = h('div'), totalEl = h('div', { class: 'total' }, '0 so\'m');
  const q = h('input', { placeholder: 'Mahsulot nomi yoki SKU...', style: 'flex:1' });
  const method = h('select', {}, h('option', { value: 'cash' }, 'Naqd'), h('option', { value: 'card' }, 'Karta'), h('option', { value: 'transfer' }, "O'tkazma"));
  const byId = new Map(products.map((p) => [p.id, p]));
  const drawList = () => {
    const s = q.value.toLowerCase();
    list.replaceChildren(...products.filter((p) => !s || p.name.toLowerCase().includes(s) || (p.sku || '').toLowerCase().includes(s)).slice(0, 60).map((p) =>
      h('button', { disabled: p.stock <= 0, onclick: () => { cart.set(p.id, Math.min((cart.get(p.id) || 0) + 1, p.stock)); drawCart(); } },
        h('span', {}, p.name), h('span', { class: 'mute' }, `${money(p.price)} · ${qf(p.stock)} ${p.unit}`))));
  };
  const drawCart = () => {
    let total = 0;
    cartEl.replaceChildren(cart.size ? table(['Mahsulot', 'Miqdor', 'Summa', ''], [...cart].map(([id, n]) => {
      const p = byId.get(id); total += Math.round(p.price * n);
      const inp = h('input', { type: 'number', min: 0, step: 'any', value: n, onchange: () => { const v = Number(inp.value); v > 0 ? cart.set(id, Math.min(v, p.stock)) : cart.delete(id); drawCart(); } });
      return [p.name, inp, money(p.price * n), h('button', { class: 'btn sec', onclick: () => { cart.delete(id); drawCart(); } }, '✕')];
    }), [2]) : h('p', { class: 'mute' }, "Savat bo'sh"));
    totalEl.textContent = money(total);
  };
  const sell = async () => {
    try {
      const r = await post('/api/sales', { method: method.value, items: [...cart].map(([product_id, qty]) => ({ product_id, qty })) });
      flash(box, `Sotuv #${r.id} saqlandi: ${money(r.total)}`, 'ok');
      for (const [id, n] of cart) byId.get(id).stock -= n;
      cart.clear(); drawCart(); drawList();
    } catch (e) { flash(box, e.message); }
  };
  q.addEventListener('input', drawList); drawList(); drawCart();
  return h('div', { class: 'cols' },
    h('div', { class: 'card' }, h('h3', {}, 'Mahsulot tanlash'), h('div', { class: 'row' }, q), list),
    h('div', { class: 'card' }, h('h3', {}, 'Savat'), box, cartEl, h('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px' }, totalEl, method),
      h('button', { class: 'btn', style: 'width:100%', onclick: sell }, 'Sotish')));
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
  const add = () => { const p = products.find((x) => x.id === Number(prod.value)); if (p && !lines.some((l) => l.id === p.id)) lines.push({ id: p.id, name: p.name, qty: 1, cost: p.cost || 0 }); draw(); };
  const loadHist = async () => {
    const rows = await get('/api/receipts?date=' + today());
    hist.replaceChildren(rows.length ? table(['Vaqt', 'Yetkazuvchi', 'Mahsulotlar', 'Summa'], rows.map((r) => [hhmm(r.created_at), r.supplier || '—', r.items, money(r.total)]), [3]) : h('p', { class: 'mute' }, 'Bugun kirim yo\'q'));
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
    h('div', { class: 'row' }, prod, h('button', { class: 'btn sec', onclick: add }, "+ Mahsulot")), area,
    h('div', { class: 'row', style: 'margin-top:10px' }, note, h('button', { class: 'btn', onclick: save }, 'Kirim qilish'))),
    h('div', { class: 'card' }, h('h3', {}, 'Bugungi kirimlar'), hist));
}

// ---------- Ombor (ikkala rol; admin tahrirlay oladi) ----------
async function stockView() {
  const isAdmin = state.user.role === 'admin';
  let products = await get('/api/products');
  const out = h('div'), box = msgBox();
  const q = h('input', { placeholder: 'Qidirish...' });
  const only = h('select', {}, h('option', { value: '' }, 'Hammasi'), h('option', { value: 'low' }, 'Faqat kam qolganlar'));
  const draw = () => {
    const s = q.value.toLowerCase();
    const rows = products.filter((p) => (!s || p.name.toLowerCase().includes(s) || (p.category || '').toLowerCase().includes(s) || (p.sku || '').toLowerCase().includes(s)) && (!only.value || p.stock <= p.min_stock));
    const head = ['Mahsulot', 'Kategoriya', 'Qoldiq', 'Min.', 'Narx', 'Holat'].concat(isAdmin ? ['Tannarx', ''] : []);
    out.replaceChildren(table(head, rows.map((p) => [p.name, p.category, `${qf(p.stock)} ${p.unit}`, qf(p.min_stock), fmt(p.price), stockTag(p)]
      .concat(isAdmin ? [fmt(p.cost), h('button', { class: 'btn sec', onclick: () => edit(p) }, 'Tahrir')] : [])), [2, 3, 4, 6]));
  };
  const form = h('div');
  const edit = (p) => {
    const f = { name: p?.name || '', sku: p?.sku || '', category: p?.category || '', unit: p?.unit || 'dona', price: p?.price || 0, cost: p?.cost || 0, min_stock: p?.min_stock || 0, stock: 0 };
    const field = (k, label, type = 'text') => h('label', { class: 'mute' }, label, h('br'), h('input', { type, step: 'any', value: f[k], oninput: (e) => { f[k] = type === 'number' ? Number(e.target.value) : e.target.value; } }));
    form.replaceChildren(h('div', { class: 'card' }, h('h3', {}, p ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot'),
      h('div', { class: 'row' }, field('name', 'Nomi'), field('sku', 'SKU'), field('category', 'Kategoriya'), field('unit', 'Birlik')),
      h('div', { class: 'row' }, field('price', 'Sotuv narxi', 'number'), field('cost', 'Tannarx', 'number'), field('min_stock', 'Minimal qoldiq', 'number'), p ? null : field('stock', 'Boshlang\'ich qoldiq', 'number')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
        try { p ? await api('PUT', '/api/products/' + p.id, f) : await post('/api/products', f); form.replaceChildren(); products = await get('/api/products'); draw(); flash(box, 'Saqlandi', 'ok'); } catch (e) { flash(box, e.message); }
      } }, 'Saqlash'), h('button', { class: 'btn sec', onclick: () => form.replaceChildren() }, 'Bekor'),
      p ? h('button', { class: 'btn bad', onclick: async () => { if (!confirm('Mahsulot arxivlansinmi?')) return; await api('PUT', '/api/products/' + p.id, { ...f, active: false }); form.replaceChildren(); products = await get('/api/products'); draw(); } }, 'Arxivlash') : null)));
    form.scrollIntoView({ behavior: 'smooth' });
  };
  q.addEventListener('input', draw); only.addEventListener('change', draw); draw();
  return h('div', {}, box, form, h('div', { class: 'card' }, h('div', { class: 'row' }, q, only, isAdmin ? h('button', { class: 'btn', onclick: () => edit(null) }, "+ Yangi mahsulot") : null), out));
}

// ---------- Sotuvchi: bugungi sotuvlar ----------
async function mySalesView() {
  const rows = await get('/api/sales?date=' + today());
  const sum = rows.reduce((a, r) => a + r.total, 0);
  return h('div', { class: 'card' }, h('h3', {}, `Bugungi sotuvlarim: ${rows.length} ta, ${money(sum)}`),
    rows.length ? table(['№', 'Vaqt', 'Mahsulotlar', 'To\'lov', 'Summa'], rows.map((r) => [r.id, hhmm(r.created_at), r.items, { cash: 'Naqd', card: 'Karta', transfer: "O'tkazma" }[r.method], money(r.total)]), [4]) : h('p', { class: 'mute' }, 'Hali sotuv yo\'q'));
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
        kpi('Cheklar', fmt(t.orders), delta(t.orders, y.orders)), kpi('Ombor qiymati (tannarx)', money(inv.cost_value), `${inv.products} ta mahsulot, ${inv.low || 0} tasi kam`)),
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
    out.replaceChildren(rows.length ? table(['№', 'Vaqt', 'Sotuvchi', 'Mahsulotlar', 'Summa'], rows.map((r) => [r.id, hhmm(r.created_at), r.seller, r.items, money(r.total)]), [4]) : h('p', { class: 'mute' }, 'Sotuv yo\'q'));
  };
  await load();
  return h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', {}, 'Sotuvlar tarixi'), h('input', { type: 'date', value: date, onchange: (e) => { date = e.target.value; load(); } })), out);
}

async function usersView() {
  const box = msgBox(), out = h('div'); const f = { username: '', name: '', password: '', role: 'seller' };
  const load = async () => {
    const us = await get('/api/admin/users');
    out.replaceChildren(table(['Login', 'Ism', 'Rol', 'Holat', ''], us.map((u) => [u.username, u.name, u.role === 'admin' ? 'Admin' : 'Sotuvchi', u.active ? 'Faol' : 'O\'chirilgan',
      h('span', { class: 'row' }, h('button', { class: 'btn sec', onclick: async () => { try { await api('PUT', '/api/admin/users/' + u.id, { active: !u.active }); load(); } catch (e) { flash(box, e.message); } } }, u.active ? 'O\'chirish' : 'Yoqish'),
        h('button', { class: 'btn sec', onclick: async () => { const pw = prompt('Yangi parol (kamida 6 belgi)'); if (pw) try { await api('PUT', '/api/admin/users/' + u.id, { password: pw }); flash(box, 'Parol almashtirildi', 'ok'); } catch (e) { flash(box, e.message); } } }, 'Parol'))])));
  };
  const inp = (k, ph, type = 'text') => h('input', { placeholder: ph, type, oninput: (e) => { f[k] = e.target.value; } });
  await load();
  return h('div', {}, box, h('div', { class: 'card' }, h('h3', {}, 'Yangi foydalanuvchi'), h('div', { class: 'row' }, inp('username', 'Login'), inp('name', 'Ism'), inp('password', 'Parol', 'password'),
    h('select', { onchange: (e) => { f.role = e.target.value; } }, h('option', { value: 'seller' }, 'Sotuvchi'), h('option', { value: 'admin' }, 'Admin')),
    h('button', { class: 'btn', onclick: async () => { try { await post('/api/admin/users', f); flash(box, 'Qo\'shildi', 'ok'); load(); } catch (e) { flash(box, e.message); } } }, "Qo'shish"))),
    h('div', { class: 'card' }, out));
}

const TABS = {
  seller: [['sell', 'Sotuv', sellView], ['receipt', 'Kirim', receiptView], ['stock', 'Ombor', stockView], ['mine', 'Sotuvlarim', mySalesView]],
  admin: [['dash', 'Tahlil', dashboardView], ['stock', 'Ombor', stockView], ['offers', 'Xarid takliflari', offersView], ['orders', 'Buyurtmalar', ordersView],
    ['receipt', 'Kirim', receiptView], ['sales', 'Sotuvlar', salesHistoryView], ['users', 'Foydalanuvchilar', usersView]],
};

async function render() {
  if (!state.user) { root.replaceChildren(loginView()); return; }
  const tabs = TABS[state.user.role]; state.tab ||= tabs[0][0];
  const main = h('main', {}, h('p', { class: 'mute' }, 'Yuklanmoqda...'));
  root.replaceChildren(h('header', {}, h('b', {}, 'Mini ERP'),
    h('nav', {}, tabs.map(([k, label]) => h('button', { class: k === state.tab ? 'on' : '', onclick: () => { state.tab = k; render(); } }, label))), h('span', { class: 'sp' }),
    h('span', { class: 'mute' }, `${state.user.name} (${state.user.role === 'admin' ? 'admin' : 'sotuvchi'})`),
    h('button', { class: 'btn sec', onclick: async () => { await post('/api/logout').catch(() => {}); state.user = null; render(); } }, 'Chiqish')), main);
  try { main.replaceChildren(await tabs.find((t) => t[0] === state.tab)[2]()); }
  catch (e) { main.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
}

get('/api/me').then((u) => { state.user = u; }).catch(() => {}).finally(render);
