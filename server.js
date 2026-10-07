import { openDb, ensureReady } from './db.js';
import { createApp } from './app.js';

const db = await openDb();
await ensureReady(db);
const port = Number(process.env.PORT || 3000);
createApp(db).listen(port, () => console.log(`Mini ERP: http://localhost:${port} (${process.env.DATABASE_URL ? 'Postgres' : 'PGlite'})`));
