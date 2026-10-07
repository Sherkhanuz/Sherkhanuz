import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Mahalliy vaqt farqi (Toshkent = UTC+5). Soatlik tahlil shu bo'yicha hisoblanadi.
export const TZ_HOURS = Number(process.env.TZ_OFFSET_HOURS ?? 5);
const LOCAL = `datetime(created_at, '${TZ_HOURS >= 0 ? '+' : ''}${TZ_HOURS} hours')`;
export const localExpr = (col = 'created_at') => LOCAL.replace('created_at', col);

export function openDb(file = process.env.DB_FILE || 'data/erp.db') {
  if (file !== ':memory:') mkdirSync(file.replace(/[^/]*$/, '') || '.', { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','seller')), password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS products(
    id INTEGER PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, category TEXT DEFAULT '',
    unit TEXT NOT NULL DEFAULT 'dona', price INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
    stock REAL NOT NULL DEFAULT 0, min_stock REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS suppliers(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '');
  CREATE TABLE IF NOT EXISTS sales(
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    total INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'cash',
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS sale_items(
    id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty REAL NOT NULL, price INTEGER NOT NULL, cost INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS receipts(
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    supplier_id INTEGER REFERENCES suppliers(id), note TEXT DEFAULT '', total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS receipt_items(
    id INTEGER PRIMARY KEY, receipt_id INTEGER NOT NULL REFERENCES receipts(id),
    product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL, cost INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS purchase_orders(
    id INTEGER PRIMARY KEY, supplier_id INTEGER REFERENCES suppliers(id),
    status TEXT NOT NULL DEFAULT 'ordered' CHECK(status IN ('ordered','received','cancelled')),
    created_by INTEGER NOT NULL REFERENCES users(id), total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT);
  CREATE TABLE IF NOT EXISTS po_items(
    id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id), qty REAL NOT NULL, cost INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS stock_moves(
    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
    type TEXT NOT NULL, qty REAL NOT NULL, ref_id INTEGER, user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
  CREATE INDEX IF NOT EXISTS idx_items_sale ON sale_items(sale_id);
  CREATE INDEX IF NOT EXISTS idx_items_prod ON sale_items(product_id);
  `);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const got = scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return timingSafeEqual(got, Buffer.from(h, 'hex'));
}

export function ensureDefaultUsers(db) {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c) return;
  const ins = db.prepare('INSERT INTO users(username,name,role,password_hash) VALUES(?,?,?,?)');
  ins.run('admin', 'Administrator', 'admin', hashPassword(process.env.ADMIN_PASSWORD || 'admin123'));
  ins.run('sotuvchi', 'Sotuvchi', 'seller', hashPassword(process.env.SELLER_PASSWORD || 'sotuvchi123'));
}
