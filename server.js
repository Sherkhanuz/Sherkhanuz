import { openDb, ensureDefaultUsers } from './db.js';
import { createApp } from './app.js';

const db = openDb();
ensureDefaultUsers(db);
const port = Number(process.env.PORT || 3000);
createApp(db).listen(port, () => console.log(`Mini ERP: http://localhost:${port}`));
