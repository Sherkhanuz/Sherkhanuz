# Mini ERP — kichik va o'rta do'konlar uchun

Ikki rolli sotuv va ombor tizimi. **Vercel** (serverless) + **Neon** (Postgres) uchun moslangan; lokalda esa hech narsa o'rnatmasdan ishlaydi (ichki Postgres — PGlite).

## Rollar va imkoniyatlar
**Sotuvchi:** sotuv (shtrixkod skaneri bilan, chegirma, nasiya, chek chop etish) · qaytarish · kirim · omborni ko'rish (tannarx ko'rinmaydi) · mijozlar va nasiya to'lovlari · bugungi sotuvlari.

**Admin:** yuqoridagilarning barchasi + ombor/mahsulotlar boshqaruvi · soatma-soat va kunma-kun tushum/foyda tahlili (mahsulot bo'yicha filtr, qaytarishlar hisobga olinadi) · eng ko'p sotilgan mahsulotlar · sotuvchilar natijasi · nasiya qoldig'i · **kam qolgan mahsulotlarga xarid taklifi** → buyurtma → qabul qilinganda omborga avtomatik kirim · foydalanuvchilar.

## Telefonda ishlatish va kamera skaneri
- Interfeys telefon ekraniga moslashgan (yuqorida aylanuvchi menyu, katta tugmalar, pastda doim ko'rinib turuvchi "Sotish" paneli). Brauzer menyusidan *Ekranga qo'shish* bilan ilova kabi o'rnatiladi.
- **Sotuv → 📷 Skanerlab sotish**: kamera to'liq ekranda ochiladi, shtrixkod (EAN-13/8, UPC, Code128/39, ITF, QR) ramkaga kelganda mahsulot savatga tushadi (ramka yashil yonadi, ovoz + tebranish). Pastdagi panelda jonli savat: har mahsulot uchun **+/−**, jami summa va **Sotish** tugmasi — skanerdan chiqmasdan sotuvni yakunlash mumkin. Kod ramkadan chiqib qaytsa, yana bir dona qo'shiladi. 🔦 chiroq va ⌨ qo'lda kod kiritish bor.
- **Kirim → 📷 Skaner**: kelgan tovarni shu tarzda skanerlab, miqdor va kirim narxini panelda kiritasiz.
- Mahsulotning **SKU** maydoni shtrixkod hisoblanadi (Ombor → Tahrir). Seed ma'lumotdagi SKU'lar haqiqiy EAN-13.
- Kamera faqat **HTTPS** (Vercel'da avtomatik) yoki `localhost` da ishlaydi. Chrome/Android'da o'rnatilgan `BarcodeDetector`, iOS Safari va boshqalarda ichki ZXing (`public/vendor/zxing.min.js`, Apache-2.0) ishlatiladi.
- Bluetooth/USB skaner ham ishlaydi: qidiruv maydoniga kod yozib Enter bosadi.

## Lokal ishga tushirish
```bash
npm install
npm run seed    # ixtiyoriy: demo ma'lumot (data/pgdata papkasiga)
npm start       # http://localhost:3000   (admin/admin123, sotuvchi/sotuvchi123)
npm test
```
`DATABASE_URL` o'rnatilsa, o'sha Postgres ishlatiladi (`TEST_DATABASE_URL` — testlar uchun, **bazani tozalaydi**).

## Vercel + Neon'ga deploy
1. **Neon:** https://neon.tech da loyiha yarating → *Connect* → **Pooled connection** manzilini nusxalang (`...-pooler...?sslmode=require`).
2. **Vercel:** *Add New → Project* → GitHub repozitoriyasini import qiling (Framework: *Other*; build buyrug'i va output'ni `vercel.json` belgilaydi).
3. *Settings → Environment Variables* ga qo'shing:
   - `DATABASE_URL` — Neon manzili
   - `ADMIN_PASSWORD` — admin paroli (**majburiy**; standart parol ishlab chiqarishda yo'q)
   - `SELLER_PASSWORD` — sotuvchi paroli (ixtiyoriy)
4. *Deploy*. Birinchi so'rovda sxema va foydalanuvchilar avtomatik yaratiladi.
5. Ixtiyoriy demo ma'lumot: kompyuteringizdan `DATABASE_URL=... npm run seed` (bo'sh bazaga).

Sxemani oldindan yaratish: `DATABASE_URL=... npm run migrate`.

## Arxitektura
```
public/            statik UI (vanilla JS) — Vercel CDN
api/index.js       yagona serverless funksiya (vercel.json: /api/* -> shu yerga)
app.js             REST API (marshrutlar, rol tekshiruvi, hisob-kitob)
db.js              Postgres qatlami: pg (Neon) yoki PGlite (lokal), sxema, parol xeshi
seed.js, migrate.js, test/
```
- Soatlik/kunlik tahlil `TZ_NAME` (standart `Asia/Tashkent`) bo'yicha hisoblanadi.
- Qaytarish — `sales` jadvalida `kind='return'` bo'lgan manfiy qatorlar; shuning uchun hamma hisobotlar avtomatik to'g'ri.
- Sessiya, login urinishlari cheklovi bazada saqlanadi (serverless'da xotiraga ishonib bo'lmaydi).
- Omborni kamaytirish atomik: `UPDATE ... WHERE stock >= qty`, ikki sotuvchi bir vaqtda sotsa ham minusga tushmaydi.
- Xavfsizlik: scrypt, HttpOnly/SameSite/Secure cookie, serverda rol tekshiruvi, `X-Requested-With` (CSRF), CSP.

## Xarid taklifi qanday hisoblanadi
Oxirgi 30 kundagi o'rtacha kunlik sotuv bo'yicha mahsulot taklifga tushadi, agar qoldiq ≤ minimal qoldiq yoki qoldiq 3 kundan kamga yetsa.
Miqdor = `max(min×2, kunlik_sotuv×14) − qoldiq − yo'ldagi buyurtma`. Yetkazib beruvchi — oxirgi kirimdagi yetkazuvchi, narx — oxirgi tannarx.

## Hali yo'q
Soliq/fiskal integratsiya, ko'p filial, offline rejim, inventarizatsiya. Bozor bilan taqqoslash: [docs/BOZOR_TAHLILI.md](docs/BOZOR_TAHLILI.md).
