# Mini ERP — kichik va o'rta do'konlar uchun

Ikki rolli sotuv va ombor tizimi. Tashqi paket kerak emas (Node.js ≥ 22.13, o'rnatilgan SQLite).

## Rollar
**Sotuvchi:** sotuv · kelgan mahsulotni kirim qilish · omborni ko'rish (tannarx ko'rinmaydi) · bugungi sotuvlari.

**Admin:** ombor holati va mahsulotlarni boshqarish · soatma-soat va kunma-kun tushum/foyda tahlili (mahsulot bo'yicha filtr) · eng ko'p sotilgan mahsulotlar · sotuvchilar natijasi · **kam qolgan mahsulotlarga xarid taklifi** → buyurtma → qabul qilinganda omborga avtomatik kirim · foydalanuvchilar.

## Ishga tushirish
```bash
npm run seed    # ixtiyoriy: demo mahsulotlar va 30 kunlik sotuv
npm start       # http://localhost:3000
npm test
```
Boshlang'ich kirish: `admin / admin123`, `sotuvchi / sotuvchi123`. Birinchi ishga tushirishdan oldin `ADMIN_PASSWORD` va `SELLER_PASSWORD` env o'zgaruvchilari bilan almashtiring (yoki "Foydalanuvchilar" bo'limida).

Sozlamalar: `PORT` (3000), `DB_FILE` (`data/erp.db`), `TZ_OFFSET_HOURS` (5 — Toshkent; soatlik tahlil shu bo'yicha).

## Xarid taklifi qanday hisoblanadi
Oxirgi 30 kundagi o'rtacha kunlik sotuv bo'yicha mahsulot taklifga tushadi, agar qoldiq ≤ minimal qoldiq yoki qoldiq 3 kundan kamga yetsa.
Miqdor = `max(min×2, kunlik_sotuv×14) − qoldiq − yo'ldagi buyurtma`. Yetkazib beruvchi — oxirgi kirimdagi yetkazuvchi, narx — oxirgi tannarx.

## Arxitektura
`db.js` (sxema, parol xeshi) · `app.js` (REST API + statik) · `public/` (vanilla JS UI) · `seed.js` · `test/`.
Xavfsizlik: scrypt parol xeshi, HttpOnly/SameSite cookie, rol tekshiruvi serverda, `X-Requested-With` himoyasi, login urinishlari cheklovi, CSP.
Cheklov: bitta server jarayoni; HTTPS ni reverse proxy (nginx/Caddy) ta'minlashi kerak.

Bozordagi yechimlar bilan taqqoslash: [docs/BOZOR_TAHLILI.md](docs/BOZOR_TAHLILI.md).
