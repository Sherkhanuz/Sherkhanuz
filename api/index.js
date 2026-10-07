// Vercel serverless funksiya: barcha /api/* so'rovlari shu yerga yo'naltiriladi (vercel.json).
import { openDb } from '../db.js';
import { createHandler } from '../app.js';

let handler;
export default async function (req, res) {
  if (!process.env.DATABASE_URL) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'DATABASE_URL o\'rnatilmagan (Neon ulanish manzili)' }));
  }
  handler ||= createHandler(await openDb());
  return handler(req, res);
}
