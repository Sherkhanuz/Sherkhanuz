// Ma'lumotlar bazasi qatlami.
//  - DATABASE_URL berilsa: Postgres (Neon) — `pg` orqali. Vercel va ishlab chiqarish uchun.
//  - Aks holda: PGlite (jarayon ichidagi haqiqiy Postgres, WASM) — lokal ishlab chiqish va testlar uchun.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const TZ = process.env.TZ_NAME || 'Asia/Tashkent';
if (!/^[A-Za-z_/+-]+$/.test(TZ)) throw new Error('TZ_NAME noto\'g\'ri');
// Mahalliy sana/soat ifodalari (soatlik tahlil do'kon vaqti bo'yicha)
export const localDate = (col) => `((${col} AT TIME ZONE '${TZ}')::date)`;
export const localHour = (col) => `(EXTRACT(HOUR FROM ${col} AT TIME ZONE '${TZ}')::int)`;

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };

function wrap(runner) {
  const db = {
    async q(sql, params = []) { return (await runner.query(toPg(sql), params)).rows; },
    async one(sql, params = []) { return (await db.q(sql, params))[0]; },
    async run(sql, params = []) { const r = await runner.query(toPg(sql), params); return r.affectedRows ?? r.rowCount ?? 0; },
    exec: (sql) => runner.exec(sql),
  };
  return db;
}

export async function openDb({ url = process.env.DATABASE_URL, dir = process.env.PGLITE_DIR || 'data/pgdata' } = {}) {
  if (url) {
    const { default: pg } = await import('pg');
    pg.types.setTypeParser(20, Number);   // int8 (BIGINT, COUNT)
    pg.types.setTypeParser(1700, Number); // numeric (SUM(bigint))
    const serverless = !!process.env.VERCEL;
    const pool = new pg.Pool({ connectionString: url, max: serverless ? 1 : 5, idleTimeoutMillis: serverless ? 5000 : 30000 });
    const db = wrap({ query: (s, p) => pool.query(s, p), exec: (s) => pool.query(s) });
    db.tx = async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(wrap({ query: (s, p) => c.query(s, p), exec: (s) => c.query(s) }));
        await c.query('COMMIT');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    };
    db.close = () => pool.end();
    return db;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir !== ':memory:') mkdirSync(dirname(dir), { recursive: true });
  const lite = new PGlite(dir === ':memory:' ? undefined : dir);
  await lite.waitReady;
  const opts = { parsers: { 20: Number, 1700: Number } }; // pg bilan bir xil: int8/numeric -> number
  const db = wrap({ query: (s, p) => lite.query(s, p, opts), exec: (s) => lite.exec(s) });
  db.tx = (fn) => lite.transaction((t) => fn(wrap({ query: (s, p) => t.query(s, p, opts), exec: (s) => t.exec(s) })));
  db.close = () => lite.close();
  return db;
}

// ============================================================================
// SXEMA (v3) — hujjatlar zanjiri
//
//   Buyurtma (purchase_orders) ──► Kirim (receipts: receipt|opening) ──► Storno (receipts: reversal)
//                                         │ receipt_items                    
//   Sotuv (sales: sale) ──► Qaytarish (sales: return, ref_sale_id)          
//         │ sale_items (return qatori -> orig_item_id)                      
//         ▼                                                                  
//   Ombor daftari (stock_moves: har biri aynan bitta hujjatga FK) ──► products.stock (faqat daftar orqali)
//   Mijoz daftari (customer_ledger: sotuv/to'lov/qaytarish) ──► customers.balance (faqat daftar orqali)
//   Yetkazuvchi daftari (supplier_ledger: kirim/to'lov/qaytim) ── (+ qarzimiz, − yetkazuvchida avansimiz)
//   Kassa daftari (cash_ledger: har bir pul harakati aynan bitta hujjatga FK) ──► cash_accounts.balance (naqd/karta/o'tkazma)
// ============================================================================
export const SCHEMA = `
CREATE TABLE users(
  id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','seller')), password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE sessions(
  token TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  revoked BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE login_attempts(
  ip TEXT PRIMARY KEY, n INT NOT NULL, t TIMESTAMPTZ NOT NULL DEFAULT now());

-- Asosiy ma'lumotlar (aktiv/noaktiv)
CREATE TABLE products(
  id BIGSERIAL PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, category TEXT DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'dona', price BIGINT NOT NULL DEFAULT 0 CHECK(price >= 0), cost BIGINT NOT NULL DEFAULT 0 CHECK(cost >= 0),
  stock DOUBLE PRECISION NOT NULL DEFAULT 0, min_stock DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(min_stock >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT chk_stock_nonneg CHECK(stock >= 0));          -- qoldiq manfiy bo'lmaydi
CREATE TABLE suppliers(
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE customers(
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '',
  balance BIGINT NOT NULL DEFAULT 0,                        -- nasiya (qarz); faqat customer_ledger orqali o'zgaradi
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT chk_balance_nonneg CHECK(balance >= 0));

-- Buyurtma
CREATE TABLE purchase_orders(
  id BIGSERIAL PRIMARY KEY, supplier_id BIGINT REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'ordered' CHECK(status IN ('ordered','received','cancelled')),
  created_by BIGINT NOT NULL REFERENCES users(id), total BIGINT NOT NULL CHECK(total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ);
CREATE TABLE po_items(
  id BIGSERIAL PRIMARY KEY, po_id BIGINT NOT NULL REFERENCES purchase_orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id), qty DOUBLE PRECISION NOT NULL CHECK(qty > 0),
  cost BIGINT NOT NULL CHECK(cost >= 0), line_total BIGINT NOT NULL CHECK(line_total >= 0), UNIQUE(po_id, product_id));

-- Kirim: receipt (qo'lda/buyurtma bo'yicha), opening (boshlang'ich qoldiq), reversal (storno)
CREATE TABLE receipts(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'receipt' CHECK(kind IN ('receipt','opening','reversal')),
  supplier_id BIGINT REFERENCES suppliers(id),
  po_id BIGINT REFERENCES purchase_orders(id),              -- buyurtma bo'yicha kirim
  ref_receipt_id BIGINT REFERENCES receipts(id),            -- storno -> asl kirim
  pay_method TEXT NOT NULL DEFAULT 'cash' CHECK(pay_method IN ('cash','card','transfer')), -- yetkazuvchisiz (naqd) xarid qaysi hisobdan to'langan
  note TEXT DEFAULT '', total BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'reversal') = (ref_receipt_id IS NOT NULL)),
  CHECK (po_id IS NULL OR kind = 'receipt'),
  CHECK (kind = 'reversal' OR total >= 0), CHECK (kind <> 'reversal' OR total <= 0));
CREATE UNIQUE INDEX uq_receipt_reversal ON receipts(ref_receipt_id) WHERE ref_receipt_id IS NOT NULL;
CREATE UNIQUE INDEX uq_receipt_po ON receipts(po_id) WHERE po_id IS NOT NULL;
CREATE TABLE receipt_items(
  id BIGSERIAL PRIMARY KEY, receipt_id BIGINT NOT NULL REFERENCES receipts(id),
  product_id BIGINT NOT NULL REFERENCES products(id), qty DOUBLE PRECISION NOT NULL CHECK(qty <> 0),
  cost BIGINT NOT NULL CHECK(cost >= 0), line_total BIGINT NOT NULL, UNIQUE(receipt_id, product_id));

-- Sotuv: sale | return (qaytarish: manfiy qatorlar, asl sotuvga bog'langan)
CREATE TABLE sales(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'sale' CHECK(kind IN ('sale','return')),
  ref_sale_id BIGINT REFERENCES sales(id), customer_id BIGINT REFERENCES customers(id),
  discount BIGINT NOT NULL DEFAULT 0 CHECK(discount >= 0), total BIGINT NOT NULL, paid BIGINT NOT NULL DEFAULT 0 CHECK(paid >= 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK(method IN ('cash','card','transfer')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'sale' AND ref_sale_id IS NULL) OR (kind = 'return' AND ref_sale_id IS NOT NULL)),
  CHECK (kind = 'return' OR (total >= 0 AND paid <= total)),
  CHECK (kind = 'sale' OR (total <= 0 AND paid = 0 AND discount = 0)));
CREATE TABLE sale_items(
  id BIGSERIAL PRIMARY KEY, sale_id BIGINT NOT NULL REFERENCES sales(id),
  product_id BIGINT NOT NULL REFERENCES products(id), orig_item_id BIGINT REFERENCES sale_items(id),
  qty DOUBLE PRECISION NOT NULL CHECK(qty <> 0), price BIGINT NOT NULL CHECK(price >= 0),
  line_total BIGINT NOT NULL, cost BIGINT NOT NULL CHECK(cost >= 0));

-- Hisobdan chiqarish (brak, yaroqlilik muddati, yo'qotish): zarar sifatida foydadan ayriladi
CREATE TABLE writeoffs(
  id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id),
  qty DOUBLE PRECISION NOT NULL CHECK(qty > 0), cost BIGINT NOT NULL CHECK(cost >= 0), total BIGINT NOT NULL CHECK(total >= 0),
  reason TEXT NOT NULL CHECK(reason IN ('damaged','expired','lost','other')), note TEXT DEFAULT '',
  user_id BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- Ombor daftari: har bir harakat aynan bitta hujjatga bog'langan (yo'qdan bor bo'lmaydi)
CREATE TABLE stock_moves(
  id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id),
  type TEXT NOT NULL CHECK(type IN ('sale','return','receipt','purchase','opening','receipt_reversal','writeoff')),
  qty DOUBLE PRECISION NOT NULL CHECK(qty <> 0),
  sale_id BIGINT REFERENCES sales(id), receipt_id BIGINT REFERENCES receipts(id), writeoff_id BIGINT REFERENCES writeoffs(id),
  user_id BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((type IN ('sale','return') AND sale_id IS NOT NULL AND receipt_id IS NULL AND writeoff_id IS NULL)
      OR (type IN ('receipt','purchase','opening','receipt_reversal') AND receipt_id IS NOT NULL AND sale_id IS NULL AND writeoff_id IS NULL)
      OR (type = 'writeoff' AND writeoff_id IS NOT NULL AND sale_id IS NULL AND receipt_id IS NULL)));

-- Mijoz qarz hujjati va daftari
CREATE TABLE debt_payments(
  id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL REFERENCES customers(id),
  user_id BIGINT NOT NULL REFERENCES users(id), amount BIGINT NOT NULL CHECK(amount > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK(method IN ('cash','card','transfer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE customer_ledger(
  id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL CHECK(kind IN ('sale_debt','payment','return_credit')), amount BIGINT NOT NULL,
  sale_id BIGINT REFERENCES sales(id), debt_payment_id BIGINT REFERENCES debt_payments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'sale_debt' AND amount > 0 AND sale_id IS NOT NULL AND debt_payment_id IS NULL)
      OR (kind = 'payment' AND amount < 0 AND debt_payment_id IS NOT NULL AND sale_id IS NULL)
      OR (kind = 'return_credit' AND amount < 0 AND sale_id IS NOT NULL AND debt_payment_id IS NULL)));

-- Yetkazuvchiga pul berish (avans/to'lov) yoki undan pul qaytarib olish (kassaga kirim)
CREATE TABLE supplier_payments(
  id BIGSERIAL PRIMARY KEY, supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  kind TEXT NOT NULL CHECK(kind IN ('payment','refund')), amount BIGINT NOT NULL CHECK(amount > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK(method IN ('cash','card','transfer')), note TEXT DEFAULT '',
  user_id BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
-- Kassa operatsiyalari: xarajat (foydadan ayriladi) va egasi pul kiritishi/olishi (foydaga ta'sir qilmaydi)
CREATE TABLE cash_operations(
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('expense','owner_deposit','owner_withdrawal')),
  category TEXT, amount BIGINT NOT NULL CHECK(amount > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK(method IN ('cash','card','transfer')), note TEXT DEFAULT '',
  user_id BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'expense') = (category IS NOT NULL)));
-- Yetkazuvchi daftari: musbat = biz qarzdormiz, manfiy = yetkazuvchida bizning avansimiz
CREATE TABLE supplier_ledger(
  id BIGSERIAL PRIMARY KEY, supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  kind TEXT NOT NULL CHECK(kind IN ('receipt','receipt_reversal','payment','refund')), amount BIGINT NOT NULL,
  receipt_id BIGINT REFERENCES receipts(id), supplier_payment_id BIGINT REFERENCES supplier_payments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'receipt' AND amount > 0 AND receipt_id IS NOT NULL AND supplier_payment_id IS NULL)
      OR (kind = 'receipt_reversal' AND amount < 0 AND receipt_id IS NOT NULL AND supplier_payment_id IS NULL)
      OR (kind = 'payment' AND amount < 0 AND supplier_payment_id IS NOT NULL AND receipt_id IS NULL)
      OR (kind = 'refund' AND amount > 0 AND supplier_payment_id IS NOT NULL AND receipt_id IS NULL)));
-- Kassa hisoblari va daftari: har bir pul harakati aynan bitta hujjatga bog'langan; qoldiq faqat daftar orqali
CREATE TABLE cash_accounts(
  method TEXT PRIMARY KEY CHECK(method IN ('cash','card','transfer')), balance BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT chk_cash_nonneg CHECK(balance >= 0));
INSERT INTO cash_accounts(method) VALUES ('cash'), ('card'), ('transfer');
CREATE TABLE cash_ledger(
  id BIGSERIAL PRIMARY KEY, method TEXT NOT NULL REFERENCES cash_accounts(method),
  kind TEXT NOT NULL CHECK(kind IN ('sale','return_refund','debt_payment','supplier_payment','supplier_refund','cash_purchase','purchase_reversal','expense','owner_deposit','owner_withdrawal')),
  amount BIGINT NOT NULL,
  sale_id BIGINT REFERENCES sales(id), debt_payment_id BIGINT REFERENCES debt_payments(id), supplier_payment_id BIGINT REFERENCES supplier_payments(id),
  receipt_id BIGINT REFERENCES receipts(id), cash_operation_id BIGINT REFERENCES cash_operations(id),
  user_id BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(sale_id, debt_payment_id, supplier_payment_id, receipt_id, cash_operation_id) = 1),
  CHECK ((kind = 'sale' AND amount > 0 AND sale_id IS NOT NULL) OR (kind = 'return_refund' AND amount < 0 AND sale_id IS NOT NULL)
      OR (kind = 'debt_payment' AND amount > 0 AND debt_payment_id IS NOT NULL)
      OR (kind = 'supplier_payment' AND amount < 0 AND supplier_payment_id IS NOT NULL) OR (kind = 'supplier_refund' AND amount > 0 AND supplier_payment_id IS NOT NULL)
      OR (kind = 'cash_purchase' AND amount < 0 AND receipt_id IS NOT NULL) OR (kind = 'purchase_reversal' AND amount > 0 AND receipt_id IS NOT NULL)
      OR (kind = 'expense' AND amount < 0 AND cash_operation_id IS NOT NULL) OR (kind = 'owner_deposit' AND amount > 0 AND cash_operation_id IS NOT NULL)
      OR (kind = 'owner_withdrawal' AND amount < 0 AND cash_operation_id IS NOT NULL)));

-- O'zgarishlar tarixi (SAP: CDHDR/CDPOS)
CREATE TABLE change_log(
  id BIGSERIAL PRIMARY KEY, table_name TEXT NOT NULL, record_id BIGINT NOT NULL,
  action CHAR(1) NOT NULL CHECK(action IN ('I','U')), field TEXT, old_value TEXT, new_value TEXT,
  user_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE INDEX idx_sales_created ON sales(created_at);
CREATE INDEX idx_sales_ref ON sales(ref_sale_id);
CREATE INDEX idx_items_sale ON sale_items(sale_id);
CREATE INDEX idx_items_prod ON sale_items(product_id);
CREATE INDEX idx_items_orig ON sale_items(orig_item_id);
CREATE INDEX idx_receipt_items_rec ON receipt_items(receipt_id);
CREATE INDEX idx_receipt_items_prod ON receipt_items(product_id);
CREATE INDEX idx_po_items_po ON po_items(po_id);
CREATE INDEX idx_moves_prod ON stock_moves(product_id);
CREATE INDEX idx_moves_sale ON stock_moves(sale_id);
CREATE INDEX idx_moves_receipt ON stock_moves(receipt_id);
CREATE INDEX idx_ledger_cust ON customer_ledger(customer_id);
CREATE INDEX idx_ledger_sale ON customer_ledger(sale_id);
CREATE INDEX idx_moves_writeoff ON stock_moves(writeoff_id);
CREATE INDEX idx_sup_ledger_sup ON supplier_ledger(supplier_id);
CREATE INDEX idx_sup_ledger_receipt ON supplier_ledger(receipt_id);
CREATE INDEX idx_cash_ledger_created ON cash_ledger(created_at);
CREATE INDEX idx_cash_ledger_sale ON cash_ledger(sale_id);
CREATE INDEX idx_cash_ledger_receipt ON cash_ledger(receipt_id);
CREATE INDEX idx_cash_ledger_ops ON cash_ledger(cash_operation_id);
CREATE INDEX idx_writeoffs_prod ON writeoffs(product_id);
CREATE INDEX idx_change_log_rec ON change_log(table_name, record_id);
`;

// ---- Ma'lumot yaxlitligi (SAP standarti) ----
// 1) Hech qaysi jadvaldan qator o'chirib bo'lmaydi (DELETE/TRUNCATE).
// 2) Hujjatlar yozilgach o'zgarmaydi — faqat storno/qaytarish bilan tuziladi.
// 3) Qoldiq (products.stock) va qarz (customers.balance) FAQAT daftar yozuvlari orqali o'zgaradi.
// 4) Har bir hujjat qatorlari, ombor harakatlari va daftar yozuvlari bilan bir-biriga TENG bo'lishi shart (tranzaksiya
//    oxirida tekshiriladi): yo'qdan bor ham, bordan yo'q ham bo'lmaydi.
// 5) Asosiy ma'lumotlar o'zgarishi change_log ga yoziladi.
const ALL_TABLES = ['users', 'sessions', 'login_attempts', 'products', 'suppliers', 'customers', 'purchase_orders', 'po_items', 'receipts',
  'receipt_items', 'sales', 'sale_items', 'stock_moves', 'debt_payments', 'customer_ledger', 'writeoffs', 'supplier_payments', 'cash_operations',
  'supplier_ledger', 'cash_accounts', 'cash_ledger', 'change_log'];
const DOCUMENTS = ['po_items', 'receipts', 'receipt_items', 'sales', 'sale_items', 'stock_moves', 'debt_payments', 'customer_ledger', 'writeoffs',
  'supplier_payments', 'cash_operations', 'supplier_ledger', 'cash_ledger', 'change_log'];
const MASTER = ['users', 'products', 'suppliers', 'customers', 'purchase_orders'];
const ERR = "USING ERRCODE = 'integrity_constraint_violation'";

export const INTEGRITY = `
CREATE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Ma''lumotni o''chirib bo''lmaydi (% jadvali): noaktiv holatga o''tkazing', TG_TABLE_NAME ${ERR}; END
$$ LANGUAGE plpgsql;
CREATE FUNCTION forbid_update() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Hujjat o''zgartirilmaydi (% jadvali): storno/qaytarish hujjati yarating', TG_TABLE_NAME ${ERR}; END
$$ LANGUAGE plpgsql;

-- Buyurtma: faqat 'ordered' -> 'received' (kirim hujjati bilan) yoki 'cancelled'
CREATE FUNCTION guard_purchase_order() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'ordered' THEN RAISE EXCEPTION 'Yopilgan buyurtma o''zgartirilmaydi' ${ERR}; END IF;
  IF (to_jsonb(NEW) - 'status' - 'closed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'closed_at') THEN
    RAISE EXCEPTION 'Buyurtma tarkibi o''zgartirilmaydi' ${ERR}; END IF;
  IF NEW.status = 'received' AND NOT EXISTS (SELECT 1 FROM receipts WHERE po_id = NEW.id AND kind = 'receipt') THEN
    RAISE EXCEPTION 'Kirim hujjatisiz buyurtmani "qabul qilindi" qilib bo''lmaydi (#%)', NEW.id ${ERR}; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Qoldiq va qarz faqat daftar yozuvi orqali o'zgaradi
CREATE FUNCTION guard_stock() RETURNS trigger AS $$
BEGIN
  IF NEW.stock IS DISTINCT FROM OLD.stock AND COALESCE(current_setting('app.ledger', true), '') <> '1' THEN
    RAISE EXCEPTION 'Qoldiq to''g''ridan-to''g''ri o''zgartirilmaydi: ombor harakati (stock_moves) hujjati kerak' ${ERR}; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE FUNCTION guard_balance() RETURNS trigger AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance AND COALESCE(current_setting('app.ledger', true), '') <> '1' THEN
    RAISE EXCEPTION 'Qarz to''g''ridan-to''g''ri o''zgartirilmaydi: mijoz daftari (customer_ledger) yozuvi kerak' ${ERR}; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE FUNCTION guard_cash_account() RETURNS trigger AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance AND COALESCE(current_setting('app.ledger', true), '') <> '1' THEN
    RAISE EXCEPTION 'Kassa qoldig''i to''g''ridan-to''g''ri o''zgartirilmaydi: kassa daftari (cash_ledger) yozuvi kerak' ${ERR}; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE FUNCTION apply_cash_entry() RETURNS trigger AS $$
BEGIN
  PERFORM set_config('app.ledger', '1', true);
  UPDATE cash_accounts SET balance = balance + NEW.amount WHERE method = NEW.method;
  PERFORM set_config('app.ledger', '', true);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE FUNCTION apply_stock_move() RETURNS trigger AS $$
BEGIN
  PERFORM set_config('app.ledger', '1', true);
  UPDATE products SET stock = ROUND((stock + NEW.qty)::numeric, 6)::float8 WHERE id = NEW.product_id;
  PERFORM set_config('app.ledger', '', true);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE FUNCTION apply_ledger_entry() RETURNS trigger AS $$
BEGIN
  PERFORM set_config('app.ledger', '1', true);
  UPDATE customers SET balance = balance + NEW.amount WHERE id = NEW.customer_id;
  PERFORM set_config('app.ledger', '', true);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Qator-darajali tekshiruv: qaytarish asl sotuv qatoriga mos va uning qoldig'idan oshmaydi
CREATE FUNCTION validate_sale_item() RETURNS trigger AS $$
DECLARE s sales%ROWTYPE; o sale_items%ROWTYPE; returned float8; returned_sum bigint;
BEGIN
  SELECT * INTO s FROM sales WHERE id = NEW.sale_id;
  IF s.kind = 'sale' THEN
    IF NEW.orig_item_id IS NOT NULL OR NEW.qty <= 0 OR NEW.line_total < 0 THEN RAISE EXCEPTION 'Sotuv qatori noto''g''ri (#%)', NEW.sale_id ${ERR}; END IF;
  ELSE
    IF NEW.orig_item_id IS NULL OR NEW.qty >= 0 OR NEW.line_total > 0 THEN RAISE EXCEPTION 'Qaytarish qatori asl sotuv qatoriga bog''lanishi va manfiy bo''lishi shart' ${ERR}; END IF;
    SELECT * INTO o FROM sale_items WHERE id = NEW.orig_item_id FOR UPDATE;
    IF NOT FOUND OR o.sale_id <> s.ref_sale_id OR o.product_id <> NEW.product_id THEN RAISE EXCEPTION 'Qaytarish qatori asl sotuvga mos emas' ${ERR}; END IF;
    SELECT COALESCE(-SUM(qty), 0), COALESCE(-SUM(line_total), 0) INTO returned, returned_sum FROM sale_items WHERE orig_item_id = o.id;
    IF returned - NEW.qty > o.qty + 1e-6 OR returned_sum - NEW.line_total > o.line_total THEN
      RAISE EXCEPTION 'Qaytarish sotilgan miqdor/summadan oshib ketdi' ${ERR}; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Hujjat-darajali tekshiruvlar (tranzaksiya oxirida, DEFERRED)
CREATE FUNCTION check_sale_doc() RETURNS trigger AS $$
DECLARE s sales%ROWTYPE; n int; sum_lines bigint; bad int; debt bigint; credit bigint; cash_in bigint; cash_out bigint;
BEGIN
  SELECT * INTO s FROM sales WHERE id = NEW.id;
  SELECT COUNT(*), COALESCE(SUM(line_total), 0) INTO n, sum_lines FROM sale_items WHERE sale_id = s.id;
  IF n = 0 THEN RAISE EXCEPTION 'Sotuv hujjatida qatorlar yo''q (#%)', s.id ${ERR}; END IF;
  IF sum_lines <> s.total THEN RAISE EXCEPTION 'Sotuv jami (%) qatorlar yig''indisiga (%) teng emas (#%)', s.total, sum_lines, s.id ${ERR}; END IF;
  SELECT COUNT(*) INTO bad FROM (SELECT product_id, SUM(qty) q FROM sale_items WHERE sale_id = s.id GROUP BY product_id) i
    FULL JOIN (SELECT product_id, SUM(-qty) q FROM stock_moves WHERE sale_id = s.id GROUP BY product_id) m USING (product_id)
    WHERE abs(COALESCE(i.q, 0) - COALESCE(m.q, 0)) > 1e-6;
  IF bad > 0 THEN RAISE EXCEPTION 'Sotuv qatorlari ombor harakatlariga mos emas (#%)', s.id ${ERR}; END IF;
  IF s.kind = 'sale' THEN
    SELECT COALESCE(SUM(amount), 0) INTO debt FROM customer_ledger WHERE sale_id = s.id AND kind = 'sale_debt';
    IF debt <> s.total - s.paid THEN RAISE EXCEPTION 'Nasiya summasi mijoz daftariga mos emas (#%)', s.id ${ERR}; END IF;
    IF s.total > s.paid AND s.customer_id IS NULL THEN RAISE EXCEPTION 'Nasiya uchun mijoz kerak (#%)', s.id ${ERR}; END IF;
    SELECT COALESCE(SUM(amount), 0) INTO cash_in FROM cash_ledger WHERE sale_id = s.id AND kind = 'sale' AND method = s.method;
    IF cash_in <> s.paid OR EXISTS (SELECT 1 FROM cash_ledger WHERE sale_id = s.id AND (kind <> 'sale' OR method <> s.method)) THEN
      RAISE EXCEPTION 'Sotuv to''lovi kassa daftariga mos emas (#%)', s.id ${ERR}; END IF;
  ELSE
    SELECT COALESCE(-SUM(amount), 0) INTO credit FROM customer_ledger WHERE sale_id = s.id AND kind = 'return_credit';
    SELECT COALESCE(-SUM(amount), 0) INTO cash_out FROM cash_ledger WHERE sale_id = s.id AND kind = 'return_refund' AND method = s.method;
    IF credit + cash_out <> -s.total OR EXISTS (SELECT 1 FROM cash_ledger WHERE sale_id = s.id AND (kind <> 'return_refund' OR method <> s.method)) THEN
      RAISE EXCEPTION 'Qaytarish summasi qarz va kassa daftariga mos emas (#%)', s.id ${ERR}; END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION check_receipt_doc() RETURNS trigger AS $$
DECLARE r receipts%ROWTYPE; n int; sum_lines bigint; bad int; orig receipts%ROWTYPE; po purchase_orders%ROWTYPE; sl bigint; cl bigint;
BEGIN
  SELECT * INTO r FROM receipts WHERE id = NEW.id;
  SELECT COUNT(*), COALESCE(SUM(line_total), 0) INTO n, sum_lines FROM receipt_items WHERE receipt_id = r.id;
  IF n = 0 THEN RAISE EXCEPTION 'Kirim hujjatida qatorlar yo''q (#%)', r.id ${ERR}; END IF;
  IF sum_lines <> r.total THEN RAISE EXCEPTION 'Kirim jami (%) qatorlar yig''indisiga (%) teng emas (#%)', r.total, sum_lines, r.id ${ERR}; END IF;
  IF r.kind = 'reversal' THEN
    SELECT COUNT(*) INTO bad FROM receipt_items WHERE receipt_id = r.id AND qty >= 0;
  ELSE
    SELECT COUNT(*) INTO bad FROM receipt_items WHERE receipt_id = r.id AND qty <= 0;
  END IF;
  IF bad > 0 THEN RAISE EXCEPTION 'Kirim qatorlari ishorasi hujjat turiga mos emas (#%)', r.id ${ERR}; END IF;
  SELECT COUNT(*) INTO bad FROM (SELECT product_id, SUM(qty) q FROM receipt_items WHERE receipt_id = r.id GROUP BY product_id) i
    FULL JOIN (SELECT product_id, SUM(qty) q FROM stock_moves WHERE receipt_id = r.id GROUP BY product_id) m USING (product_id)
    WHERE abs(COALESCE(i.q, 0) - COALESCE(m.q, 0)) > 1e-6;
  IF bad > 0 THEN RAISE EXCEPTION 'Kirim qatorlari ombor harakatlariga mos emas (#%)', r.id ${ERR}; END IF;
  IF r.kind = 'reversal' THEN  -- storno asl kirimning aynan teskarisi
    SELECT * INTO orig FROM receipts WHERE id = r.ref_receipt_id;
    IF orig.kind <> 'receipt' OR orig.total <> -r.total THEN RAISE EXCEPTION 'Storno asl kirimga mos emas (#%)', r.id ${ERR}; END IF;
    SELECT COUNT(*) INTO bad FROM (SELECT product_id, SUM(qty) q FROM receipt_items WHERE receipt_id = r.id GROUP BY product_id) i
      FULL JOIN (SELECT product_id, SUM(-qty) q FROM receipt_items WHERE receipt_id = r.ref_receipt_id GROUP BY product_id) o USING (product_id)
      WHERE abs(COALESCE(i.q, 0) - COALESCE(o.q, 0)) > 1e-6;
    IF bad > 0 THEN RAISE EXCEPTION 'Storno qatorlari asl kirimga mos emas (#%)', r.id ${ERR}; END IF;
  END IF;
  -- Pul tomoni: yetkazuvchili kirim yetkazuvchi hisobiga (qarz/avansdan ayriladi), yetkazuvchisiz — kassadan to'lanadi
  SELECT COALESCE(SUM(amount), 0) INTO sl FROM supplier_ledger WHERE receipt_id = r.id AND supplier_id IS NOT DISTINCT FROM r.supplier_id;
  SELECT COALESCE(SUM(amount), 0) INTO cl FROM cash_ledger WHERE receipt_id = r.id AND method = r.pay_method;
  IF r.kind = 'opening' THEN
    IF EXISTS (SELECT 1 FROM supplier_ledger WHERE receipt_id = r.id) OR EXISTS (SELECT 1 FROM cash_ledger WHERE receipt_id = r.id) THEN
      RAISE EXCEPTION 'Boshlang''ich qoldiq pul harakati yaratmaydi (#%)', r.id ${ERR}; END IF;
  ELSIF r.supplier_id IS NOT NULL THEN
    IF sl <> r.total OR EXISTS (SELECT 1 FROM cash_ledger WHERE receipt_id = r.id) THEN
      RAISE EXCEPTION 'Kirim yetkazuvchi daftariga mos emas (#%)', r.id ${ERR}; END IF;
  ELSE
    IF cl <> -r.total OR EXISTS (SELECT 1 FROM supplier_ledger WHERE receipt_id = r.id) OR EXISTS (SELECT 1 FROM cash_ledger WHERE receipt_id = r.id AND method <> r.pay_method) THEN
      RAISE EXCEPTION 'Naqd xarid kassa daftariga mos emas (#%)', r.id ${ERR}; END IF;
  END IF;
  IF r.po_id IS NOT NULL THEN  -- buyurtma bo'yicha kirim buyurtma qatorlariga teng
    SELECT * INTO po FROM purchase_orders WHERE id = r.po_id;
    IF po.supplier_id IS DISTINCT FROM r.supplier_id THEN RAISE EXCEPTION 'Kirim yetkazuvchisi buyurtmaga mos emas (#%)', r.id ${ERR}; END IF;
    SELECT COUNT(*) INTO bad FROM (SELECT product_id, SUM(qty) q, SUM(line_total) t FROM receipt_items WHERE receipt_id = r.id GROUP BY product_id) i
      FULL JOIN (SELECT product_id, SUM(qty) q, SUM(line_total) t FROM po_items WHERE po_id = r.po_id GROUP BY product_id) o USING (product_id)
      WHERE abs(COALESCE(i.q, 0) - COALESCE(o.q, 0)) > 1e-6 OR COALESCE(i.t, 0) <> COALESCE(o.t, 0);
    IF bad > 0 THEN RAISE EXCEPTION 'Kirim buyurtma qatorlariga mos emas (#%)', r.id ${ERR}; END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION check_po_doc() RETURNS trigger AS $$
DECLARE n int; sum_lines bigint;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(line_total), 0) INTO n, sum_lines FROM po_items WHERE po_id = NEW.id;
  IF n = 0 THEN RAISE EXCEPTION 'Buyurtmada qatorlar yo''q (#%)', NEW.id ${ERR}; END IF;
  IF sum_lines <> NEW.total THEN RAISE EXCEPTION 'Buyurtma jami qatorlar yig''indisiga teng emas (#%)', NEW.id ${ERR}; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION check_debt_payment() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_ledger WHERE debt_payment_id = NEW.id AND customer_id = NEW.customer_id AND amount = -NEW.amount AND kind = 'payment') THEN
    RAISE EXCEPTION 'To''lov mijoz daftariga yozilmagan (#%)', NEW.id ${ERR}; END IF;
  IF NOT EXISTS (SELECT 1 FROM cash_ledger WHERE debt_payment_id = NEW.id AND amount = NEW.amount AND method = NEW.method AND kind = 'debt_payment') THEN
    RAISE EXCEPTION 'Mijoz to''lovi kassa daftariga yozilmagan (#%)', NEW.id ${ERR}; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION check_supplier_payment() RETURNS trigger AS $$
DECLARE sign int := CASE WHEN NEW.kind = 'payment' THEN -1 ELSE 1 END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supplier_ledger WHERE supplier_payment_id = NEW.id AND supplier_id = NEW.supplier_id AND kind = NEW.kind AND amount = sign * NEW.amount) THEN
    RAISE EXCEPTION 'Yetkazuvchi to''lovi yetkazuvchi daftariga yozilmagan (#%)', NEW.id ${ERR}; END IF;
  IF NOT EXISTS (SELECT 1 FROM cash_ledger WHERE supplier_payment_id = NEW.id AND method = NEW.method AND amount = sign * NEW.amount
                 AND kind = CASE WHEN NEW.kind = 'payment' THEN 'supplier_payment' ELSE 'supplier_refund' END) THEN
    RAISE EXCEPTION 'Yetkazuvchi to''lovi kassa daftariga yozilmagan (#%)', NEW.id ${ERR}; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION check_cash_operation() RETURNS trigger AS $$
DECLARE sign int := CASE WHEN NEW.kind = 'owner_deposit' THEN 1 ELSE -1 END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cash_ledger WHERE cash_operation_id = NEW.id AND kind = NEW.kind AND method = NEW.method AND amount = sign * NEW.amount) THEN
    RAISE EXCEPTION 'Kassa operatsiyasi kassa daftariga yozilmagan (#%)', NEW.id ${ERR}; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION check_writeoff() RETURNS trigger AS $$
BEGIN
  IF (SELECT COUNT(*) FROM stock_moves WHERE writeoff_id = NEW.id) <> 1 OR
     NOT EXISTS (SELECT 1 FROM stock_moves WHERE writeoff_id = NEW.id AND product_id = NEW.product_id AND type = 'writeoff' AND abs(qty + NEW.qty) < 0.000001) THEN
    RAISE EXCEPTION 'Hisobdan chiqarish ombor harakatiga mos emas (#%)', NEW.id ${ERR}; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION log_changes() RETURNS trigger AS $$
DECLARE k text; o jsonb; n jsonb; uid bigint;
BEGIN
  uid := NULLIF(current_setting('app.user_id', true), '')::bigint;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO change_log(table_name, record_id, action, user_id) VALUES (TG_TABLE_NAME, NEW.id, 'I', uid);
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD); n := to_jsonb(NEW);
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    CONTINUE WHEN k IN ('stock', 'balance'); -- bular daftardan (stock_moves, customer_ledger) kelib chiqadi
    IF o->k IS DISTINCT FROM n->k THEN
      INSERT INTO change_log(table_name, record_id, action, field, old_value, new_value, user_id)
      VALUES (TG_TABLE_NAME, NEW.id, 'U', k, CASE WHEN k = 'password_hash' THEN '***' ELSE o->>k END,
              CASE WHEN k = 'password_hash' THEN '***' ELSE n->>k END, uid);
    END IF;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

${ALL_TABLES.map((t) => `CREATE TRIGGER trg_nodelete BEFORE DELETE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER trg_notruncate BEFORE TRUNCATE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();`).join('\n')}
${DOCUMENTS.map((t) => `CREATE TRIGGER trg_immutable BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION forbid_update();`).join('\n')}
CREATE TRIGGER trg_po_guard BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION guard_purchase_order();
CREATE TRIGGER trg_guard_stock BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION guard_stock();
CREATE TRIGGER trg_guard_balance BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION guard_balance();
CREATE TRIGGER trg_guard_cash BEFORE UPDATE ON cash_accounts FOR EACH ROW EXECUTE FUNCTION guard_cash_account();
CREATE TRIGGER trg_apply_cash AFTER INSERT ON cash_ledger FOR EACH ROW EXECUTE FUNCTION apply_cash_entry();
CREATE CONSTRAINT TRIGGER trg_supplier_payment_doc AFTER INSERT ON supplier_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_supplier_payment();
CREATE CONSTRAINT TRIGGER trg_cash_op_doc AFTER INSERT ON cash_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cash_operation();
CREATE CONSTRAINT TRIGGER trg_writeoff_doc AFTER INSERT ON writeoffs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_writeoff();
CREATE TRIGGER trg_apply_move AFTER INSERT ON stock_moves FOR EACH ROW EXECUTE FUNCTION apply_stock_move();
CREATE TRIGGER trg_apply_ledger AFTER INSERT ON customer_ledger FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();
CREATE TRIGGER trg_validate_item BEFORE INSERT ON sale_items FOR EACH ROW EXECUTE FUNCTION validate_sale_item();
CREATE CONSTRAINT TRIGGER trg_sale_doc AFTER INSERT ON sales DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_sale_doc();
CREATE CONSTRAINT TRIGGER trg_receipt_doc AFTER INSERT ON receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_receipt_doc();
CREATE CONSTRAINT TRIGGER trg_po_doc AFTER INSERT ON purchase_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_po_doc();
CREATE CONSTRAINT TRIGGER trg_debt_doc AFTER INSERT ON debt_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_debt_payment();
${MASTER.map((t) => `CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION log_changes();`).join('\n')}
`;

// Sxema versiyasi: SCHEMA/INTEGRITY o'zgarganda oshiring. Bir vaqtda bir nechta serverless nusxa ishga tushsa ham
// migratsiya advisory lock ostida faqat bir marta bajariladi (tranzaksion DDL).
export const SCHEMA_VERSION = 4;
export async function migrate(db) {
  await db.tx(async (t) => {
    await t.q('SELECT pg_advisory_xact_lock(727001)');
    await t.exec('CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY, value INT NOT NULL)');
    const cur = (await t.one("SELECT value FROM schema_meta WHERE key='version'"))?.value ?? 0;
    if (cur >= SCHEMA_VERSION) return;
    if (cur > 0) throw new Error(`Baza sxemasi eski (v${cur}, kerak v${SCHEMA_VERSION}). Loyiha hali ishlab chiqarishga chiqmagan: bazani qayta yarating (Neon: yangi branch/baza yoki "DROP SCHEMA public CASCADE; CREATE SCHEMA public;")`);
    await t.exec(SCHEMA);
    await t.exec(INTEGRITY);
    await t.run("INSERT INTO schema_meta(key,value) VALUES('version',?) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [SCHEMA_VERSION]);
  });
}

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [s, h] = stored.split(':');
  return timingSafeEqual(scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
}

const isProd = () => !!process.env.VERCEL || process.env.NODE_ENV === 'production';


// Birinchi admin/sotuvchi. Ishlab chiqarishda parol env orqali majburiy (standart parol yo'q).
export async function ensureDefaultUsers(db) {
  if ((await db.one('SELECT COUNT(*)::int c FROM users')).c) return;
  const adminPw = process.env.ADMIN_PASSWORD || (isProd() ? null : 'admin123');
  const sellerPw = process.env.SELLER_PASSWORD || (isProd() ? null : 'sotuvchi123');
  if (!adminPw) throw new Error('ADMIN_PASSWORD o\'rnatilmagan: birinchi admin yaratib bo\'lmaydi');
  const ins = 'INSERT INTO users(username,name,role,password_hash) VALUES(?,?,?,?) ON CONFLICT (username) DO NOTHING';
  await db.run(ins, ['admin', 'Administrator', 'admin', hashPassword(adminPw)]);
  if (sellerPw) await db.run(ins, ['sotuvchi', 'Sotuvchi', 'seller', hashPassword(sellerPw)]);
}

// Har bir (sovuq) ishga tushishda bir marta
const ready = new WeakMap();
export function ensureReady(db) {
  if (!ready.has(db)) {
    ready.set(db, (async () => { await migrate(db); await ensureDefaultUsers(db); })().catch((e) => { ready.delete(db); throw e; }));
  }
  return ready.get(db);
}
