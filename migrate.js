// Sxemani yaratish (Neon yoki lokal). Ishga tushirish: DATABASE_URL=... npm run migrate
import { openDb, migrate, ensureDefaultUsers } from './db.js';
const db = await openDb();
await migrate(db);
await ensureDefaultUsers(db);
console.log('Sxema tayyor.');
await db.close();
