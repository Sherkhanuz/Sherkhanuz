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

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','seller')), password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS login_attempts(
  ip TEXT PRIMARY KEY, n INT NOT NULL, t TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS products(
  id BIGSERIAL PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, category TEXT DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'dona', price BIGINT NOT NULL DEFAULT 0, cost BIGINT NOT NULL DEFAULT 0,
  stock DOUBLE PRECISION NOT NULL DEFAULT 0, min_stock DOUBLE PRECISION NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS suppliers(
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS customers(
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '',
  balance BIGINT NOT NULL DEFAULT 0 CHECK(balance >= 0)); -- balance = nasiya (qarz)
CREATE TABLE IF NOT EXISTS debt_payments(
  id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL REFERENCES customers(id),
  user_id BIGINT NOT NULL REFERENCES users(id), amount BIGINT NOT NULL CHECK(amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
-- kind='return' — qaytarish: manfiy miqdor/summali qatorlar, shuning uchun tahlil avtomatik hisobga oladi
CREATE TABLE IF NOT EXISTS sales(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'sale' CHECK(kind IN ('sale','return')),
  ref_sale_id BIGINT REFERENCES sales(id), customer_id BIGINT REFERENCES customers(id),
  discount BIGINT NOT NULL DEFAULT 0, total BIGINT NOT NULL, paid BIGINT NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'cash', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sale_items(
  id BIGSERIAL PRIMARY KEY, sale_id BIGINT NOT NULL REFERENCES sales(id),
  product_id BIGINT NOT NULL REFERENCES products(id), orig_item_id BIGINT REFERENCES sale_items(id),
  qty DOUBLE PRECISION NOT NULL, price BIGINT NOT NULL, line_total BIGINT NOT NULL, cost BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  supplier_id BIGINT REFERENCES suppliers(id), note TEXT DEFAULT '', total BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS receipt_items(
  id BIGSERIAL PRIMARY KEY, receipt_id BIGINT NOT NULL REFERENCES receipts(id),
  product_id BIGINT NOT NULL REFERENCES products(id), qty DOUBLE PRECISION NOT NULL, cost BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS purchase_orders(
  id BIGSERIAL PRIMARY KEY, supplier_id BIGINT REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'ordered' CHECK(status IN ('ordered','received','cancelled')),
  created_by BIGINT NOT NULL REFERENCES users(id), total BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS po_items(
  id BIGSERIAL PRIMARY KEY, po_id BIGINT NOT NULL REFERENCES purchase_orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id), qty DOUBLE PRECISION NOT NULL, cost BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_moves(
  id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id),
  type TEXT NOT NULL, qty DOUBLE PRECISION NOT NULL, ref_id BIGINT, user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_items_prod ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_items_orig ON sale_items(orig_item_id);
CREATE INDEX IF NOT EXISTS idx_receipt_items_prod ON receipt_items(product_id);

-- Holat (aktiv/noaktiv): ma'lumot o'chirilmaydi, faqat noaktiv qilinadi
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
-- Sessiya o'chirilmaydi, bekor qilinadi
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked BOOLEAN NOT NULL DEFAULT FALSE;
-- Kirimni tuzatish: storno hujjati (kind='reversal'), asl hujjatga bog'langan
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'receipt' CHECK(kind IN ('receipt','reversal'));
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ref_receipt_id BIGINT REFERENCES receipts(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_reversal ON receipts(ref_receipt_id) WHERE ref_receipt_id IS NOT NULL;

-- O'zgarishlar tarixi (SAP: CDHDR/CDPOS): kim, qachon, qaysi maydonni, eski -> yangi
CREATE TABLE IF NOT EXISTS change_log(
  id BIGSERIAL PRIMARY KEY, table_name TEXT NOT NULL, record_id BIGINT NOT NULL,
  action CHAR(1) NOT NULL CHECK(action IN ('I','U')), field TEXT, old_value TEXT, new_value TEXT,
  user_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_change_log_rec ON change_log(table_name, record_id);
`;

// ---- Ma'lumot yaxlitligi (SAP standarti) ----
// 1) Hech qaysi jadvaldan qator o'chirib bo'lmaydi (DELETE/TRUNCATE) — DB darajasida.
// 2) Hujjatlar (sotuv, kirim, harakatlar, to'lovlar...) yozilgach o'zgarmaydi — faqat storno/qaytarish hujjati bilan tuzatiladi.
// 3) Asosiy ma'lumotlar (mahsulot, mijoz, yetkazuvchi, foydalanuvchi) o'zgarishi change_log ga yoziladi.
const ALL_TABLES = ['users', 'sessions', 'login_attempts', 'products', 'suppliers', 'customers', 'debt_payments', 'sales', 'sale_items',
  'receipts', 'receipt_items', 'purchase_orders', 'po_items', 'stock_moves', 'change_log'];
const DOCUMENTS = ['debt_payments', 'sales', 'sale_items', 'receipts', 'receipt_items', 'po_items', 'stock_moves', 'change_log'];
const MASTER = ['users', 'products', 'suppliers', 'customers', 'purchase_orders'];

export const INTEGRITY = `
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Ma''lumotni o''chirib bo''lmaydi (% jadvali): noaktiv holatga o''tkazing', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation'; END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_update() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Hujjat o''zgartirilmaydi (% jadvali): storno/qaytarish hujjati yarating', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation'; END
$$ LANGUAGE plpgsql;

-- Buyurtma: faqat 'ordered' -> 'received'/'cancelled' (status va yopilish vaqti); qolgan maydonlar o'zgarmaydi
CREATE OR REPLACE FUNCTION guard_purchase_order() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'ordered' THEN RAISE EXCEPTION 'Yopilgan buyurtma o''zgartirilmaydi' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'closed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'closed_at') THEN
    RAISE EXCEPTION 'Buyurtma tarkibi o''zgartirilmaydi' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION log_changes() RETURNS trigger AS $$
DECLARE k text; o jsonb; n jsonb; uid bigint;
BEGIN
  uid := NULLIF(current_setting('app.user_id', true), '')::bigint;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO change_log(table_name, record_id, action, user_id) VALUES (TG_TABLE_NAME, NEW.id, 'I', uid);
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD); n := to_jsonb(NEW);
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    CONTINUE WHEN k IN ('stock', 'balance'); -- bular harakatlar daftaridan (stock_moves, sales) kelib chiqadi
    IF o->k IS DISTINCT FROM n->k THEN
      INSERT INTO change_log(table_name, record_id, action, field, old_value, new_value, user_id)
      VALUES (TG_TABLE_NAME, NEW.id, 'U', k, CASE WHEN k = 'password_hash' THEN '***' ELSE o->>k END,
              CASE WHEN k = 'password_hash' THEN '***' ELSE n->>k END, uid);
    END IF;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

${ALL_TABLES.map((t) => `CREATE OR REPLACE TRIGGER trg_nodelete BEFORE DELETE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
CREATE OR REPLACE TRIGGER trg_notruncate BEFORE TRUNCATE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();`).join('\n')}
${DOCUMENTS.map((t) => `CREATE OR REPLACE TRIGGER trg_immutable BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION forbid_update();`).join('\n')}
CREATE OR REPLACE TRIGGER trg_po_guard BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION guard_purchase_order();
${MASTER.map((t) => `CREATE OR REPLACE TRIGGER trg_audit AFTER INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION log_changes();`).join('\n')}
`;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [s, h] = stored.split(':');
  return timingSafeEqual(scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
}

const isProd = () => !!process.env.VERCEL || process.env.NODE_ENV === 'production';

// Sxema versiyasi: SCHEMA/INTEGRITY o'zgarganda oshiring. Bir vaqtda bir nechta serverless nusxa ishga tushsa ham
// migratsiya advisory lock ostida faqat bir marta bajariladi (tranzaksion DDL).
export const SCHEMA_VERSION = 2;
export async function migrate(db) {
  await db.tx(async (t) => {
    await t.q('SELECT pg_advisory_xact_lock(727001)');
    await t.exec('CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY, value INT NOT NULL)');
    const cur = (await t.one("SELECT value FROM schema_meta WHERE key='version'"))?.value ?? 0;
    if (cur >= SCHEMA_VERSION) return;
    await t.exec(SCHEMA);
    await t.exec(INTEGRITY);
    await t.run("INSERT INTO schema_meta(key,value) VALUES('version',?) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [SCHEMA_VERSION]);
  });
}

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
