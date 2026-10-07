# Mini ERP — kichik va o'rta do'konlar uchun

Ikki rolli sotuv va ombor tizimi. **Vercel** (serverless) + **Neon** (Postgres) uchun moslangan; lokalda esa hech narsa o'rnatmasdan ishlaydi (ichki Postgres — PGlite).

## Rollar va imkoniyatlar
**Sotuvchi:** sotuv (shtrixkod skaneri bilan, chegirma, nasiya, chek chop etish) · qaytarish · kirim · **yetkazuvchi hisobi** (avans/pul berish, qarz to'lash, ishlatilmagan avansni qaytarib olish) · **kassa** (naqd/karta/o'tkazma, kun harakati) · omborni ko'rish (tannarx ko'rinmaydi) · mijozlar va nasiya to'lovlari · bugungi sotuvlari.

**Admin:** yuqoridagilarning barchasi + ombor/mahsulotlar boshqaruvi · soatma-soat va kunma-kun tushum/foyda tahlili (mahsulot bo'yicha filtr, qaytarishlar hisobga olinadi) · eng ko'p sotilgan mahsulotlar · sotuvchilar natijasi · nasiya qoldig'i · **Moliya** (foyda-zarar, pul oqimi, hozirgi holat) · kassa operatsiyalari (xarajat, egasi pul kiritishi/olishi) · hisobdan chiqarish (brak) · **kam qolgan mahsulotlarga xarid taklifi** → buyurtma → qabul qilinganda omborga avtomatik kirim · foydalanuvchilar.

## Moliya: foyda, daromad, kassa
**Yetkazuvchi bilan ishlash.** Sotuvchi *Yetkazuvchi hisobi* bo'limida yetkazuvchiga pul beradi (avans yoki qarz to'lovi) — kassadan chiqadi. Shu yetkazuvchidan keyin tovar qabul qilinsa (*Kirim*), summa avansdan **avtomatik ayriladi**; avansdan ortig'i qarz bo'ladi. Yetkazuvchida qolgan avansni qaytarib olinsa — pul **kassaga kiradi**. Yetkazuvchisiz kirim "naqd xarid" hisoblanadi va kassadan to'lanadi.

**Kassa** — uch hisob (naqd, karta, o'tkazma); faqat hujjat orqali o'zgaradi va manfiy bo'lmaydi (pul yetmasa chiqim rad etiladi). Kirim: sotuvda to'langan summa, mijoz qarz to'lovi, yetkazuvchi qaytimi, egasi kiritgan pul. Chiqim: qaytarishda qaytarilgan pul, yetkazuvchiga to'lov, naqd xarid, xarajat, egasi olgan pul.

**Foyda hisobi (admin → Moliya):**
```
Sof tushum (daromad)   = sotuv − qaytarishlar              (chegirmalar allaqachon ayrilgan)
Yalpi foyda            = sof tushum − sotilgan tovar tannarxi
Sof foyda              = yalpi foyda − hisobdan chiqarish (brak...) − xarajatlar
```
- **Tannarx — harakatlanuvchi o'rtacha (SAP MAP):** har kirimda `yangi = (qoldiq·tannarx + kirim·narx) / (qoldiq + kirim)`. Sotuvda tannarx sotuv paytida qotiriladi, qaytarishda shu tannarx bilan teskari yoziladi. Kirim narxi **majburiy** (0 bo'lmasin).
- **Pul oqimi:** davr boshiga qoldiq + kirim − chiqim = davr oxiriga qoldiq (manba bo'yicha taqsimot bilan). Egasi pul kiritishi/olishi foydaga ta'sir qilmaydi, xarajat esa ta'sir qiladi.
- **Hozirgi holat:** kassa + ombor (o'rtacha tannarxda) + mijoz qarzi + yetkazuvchilardagi avanslar − yetkazuvchilarga qarz = sof aktivlar. (Egasi kiritgan kapital + yig'ilgan sof foyda bilan yaxlitlash aniqligida mos keladi.)
- Xarajat turlari: ijara, ish haqi, kommunal, transport, soliq, reklama, boshqa.

Barcha pul va hisobot yozuvlari hujjatlar zanjiriga bog'langan: [docs/HUJJATLAR_ZANJIRI.md](docs/HUJJATLAR_ZANJIRI.md).

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

## Ma'lumot yaxlitligi (SAP tamoyillari)
Batafsil hujjatlar zanjiri, diagramma va qoidalar: **[docs/HUJJATLAR_ZANJIRI.md](docs/HUJJATLAR_ZANJIRI.md)**.

Ma'lumot **hech qachon o'chirilmaydi** — faqat **aktiv / noaktiv** holatga o'tadi. Bu qoidalar ilovada emas, **bazaning o'zida** (trigger) majburlanadi, shuning uchun xato yoki hujum ham ularni buzolmaydi.

| Qoida | Qanday |
|---|---|
| O'chirish taqiqlangan | Barcha jadvallarda `DELETE` va `TRUNCATE` bazada rad etiladi (sessiya va login urinishlari ham: bekor qilinadi/nolga tushiriladi, o'chirilmaydi) |
| Asosiy ma'lumotlar: aktiv/noaktiv | Mahsulot, mijoz, yetkazib beruvchi, foydalanuvchi. Noaktiv yangi sotuv/kirim/buyurtmada ishlatilmaydi, tarixi saqlanadi, istalgan payt qayta faollashtiriladi |
| Noaktiv qilish tekshiruvlari | Mahsulot: qoldiq 0 va ochiq buyurtma yo'q · Mijoz: qarz 0 · Yetkazuvchi: ochiq buyurtma yo'q · Oxirgi admin noaktiv bo'lmaydi |
| Hujjatlar o'zgarmas | Sotuv, kirim, harakatlar, to'lovlar, buyurtma qatorlari yozilgach `UPDATE` rad etiladi. Buyurtmada faqat holat (`ordered` → `received`/`cancelled`) o'zgaradi |
| Tuzatish — storno | Qaytarish (sotuv uchun) va kirim stornosi (admin) — asl hujjatga bog'langan **teskari hujjat**; ikki marta storno qilib bo'lmaydi |
| O'zgarishlar tarixi | `change_log`: kim, qachon, qaysi maydon, eski → yangi (narx, tannarx, holat, ... parollar `***`). Admin → **Tarix** |
| Hujjatlar zanjiri | Har bir hujjat bog'langan: buyurtma → kirim → storno; sotuv → qaytarish; to'lov. Hujjat jami = qatorlar, qatorlar = ombor harakatlari, nasiya = mijoz daftari (tranzaksiya oxirida baza tekshiradi). Admin → **Hujjatlar** |
| Qoldiq va qarz | `stock`/`balance` faqat daftar (`stock_moves`, `customer_ledger`) orqali o'zgaradi; to'g'ridan-to'g'ri `UPDATE` bazada rad etiladi, manfiy bo'lmaydi |
| Nazorat | Admin → Hujjatlar → **Tekshirish**: 19 ta solishtirish hisoboti (`/api/admin/integrity`) |

Qo'shimcha himoya (tavsiya): ishlab chiqarishda ilova uchun alohida DB roli oching va unga `DELETE`/`TRUNCATE`/`TRIGGER` huquqini bermang — trigger'ni o'chirish ham mumkin bo'lmaydi.
**Eslatma (v4 sxema):** loyiha hali ishlab chiqarishga chiqmagani uchun eski (v2/v3) bazadan migratsiya yo'q — bazani qayta yarating (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` yoki yangi Neon baza/branch).
Cheklov: hujjat raqamlari ketma-ket (gapless) kafolatlanmaydi (bekor qilingan tranzaksiya raqam "teshigi" qoldirishi mumkin).

## Arxitektura
```
public/            statik UI (vanilla JS) — Vercel CDN
api/index.js       yagona serverless funksiya (vercel.json: /api/* -> shu yerga)
app.js             REST API (marshrutlar, rol tekshiruvi, hisob-kitob)
db.js              Postgres qatlami: pg (Neon) yoki PGlite (lokal), sxema + yaxlitlik triggerlari (hujjatlar zanjiri), versiyali migratsiya (advisory lock)
docs/              BOZOR_TAHLILI.md, HUJJATLAR_ZANJIRI.md
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
Soliq/fiskal integratsiya, ko'p filial, offline rejim, inventarizatsiya. Bozor bilan taqqoslash: [docs/BOZOR_TAHLILI.md](docs/BOZOR_TAHLILI.md). Hujjatlar zanjiri: [docs/HUJJATLAR_ZANJIRI.md](docs/HUJJATLAR_ZANJIRI.md).
