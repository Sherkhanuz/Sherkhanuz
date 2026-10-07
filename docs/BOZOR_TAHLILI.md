# Bozordagi o'xshash yechimlar: Basic va Pro daraja

> **Eslatma.** Bu hujjat mavjud bilimga asoslangan — jonli internet tekshiruvi o'tkazilmadi. Narxlar, tarif nomlari va funksiyalar tez o'zgaradi, shuning uchun qaror qilishdan oldin rasmiy saytdan tekshiring (bu yerda aniq narx keltirilmagan). "Basic/Pro" — "organ va pro" so'rovini boshlang'ich va ilg'or daraja deb talqin qildim. Boshqacha nazarda tutilgan bo'lsa, tuzatiladi.

## 1. Daraja mezonlari

| | **Basic** (boshlang'ich) | **Pro** (ilg'or) |
|---|---|---|
| Sotuv (kassa) | Chek, naqd/karta | + chegirma, loyalty, ko'p kassa, offline rejim, fiskal/soliq integratsiya |
| Ombor | Qoldiq, kirim/chiqim | + ko'p ombor, partiya/yaroqlilik, inventarizatsiya, shtrixkod |
| Rollar | Egasi + kassir | + batafsil ruxsatlar, audit jurnali |
| Tahlil | Kunlik tushum, qoldiq | + soatlik/kunlik/mahsulot bo'yicha, ABC-tahlil, foyda marjasi, prognoz |
| Xarid | Qo'lda | + minimal qoldiq ogohlantirishi, **avtomatik xarid taklifi**, yetkazib beruvchiga buyurtma |
| Integratsiya | Yo'q / Excel | + buxgalteriya (1C), marketplace, to'lov tizimlari, API |

## 2. O'zbekiston / MDH bozori

| Mahsulot | Basic daraja | Pro daraja | Kuchli tomoni | Kamchiligi |
|---|---|---|---|---|
| **Billz** (O'zbekiston) | Kassa + oddiy ombor + hisobotlar | Ko'p filial, CRM/loyalty, tahlil, integratsiyalar | Mahalliy: UZ tili, mahalliy to'lov tizimlari, soliq talablari, mahalliy qo'llab-quvvatlash | Xarid avtomatlashtirishi chuqur bo'lmasligi mumkin (tekshirish kerak) |
| **Smartup ERP** (O'zbekiston) | — (asosan o'rta/yirik) | Distribyutsiya, savdo agentlari, ombor, xarid, tahlil | Ulgurji/distribyutor uchun kuchli | Kichik do'kon uchun ortiqcha murakkab |
| **SalesDoctor** | — | Savdo agentlari, buyurtma, yetkazish, ombor | FMCG distribyutsiya | Chakana kassa uchun emas |
| **МойСклад (MoySklad)** | Ombor, sotuv, kassa | Ko'p ombor, API, integratsiyalar | Qulay interfeys, MDH uchun mos, ochiq API | O'zbekiston lokalizatsiyasi cheklangan |
| **1С: Розница / Управление торговлей** | Розница (kichik) | UT (o'rta/katta) | Buxgalteriya bilan chuqur bog'liq, keng funksional | Sozlash uchun mutaxassis kerak |
| **Poster / iiko** | Kafe/restoran POS | Tarmoq boshqaruvi | Horeca uchun kuchli | Chakana do'kon uchun mo'ljallanmagan |

## 3. Xalqaro yechimlar

| Mahsulot | Basic daraja | Pro daraja | Kuchli tomoni | Kamchiligi |
|---|---|---|---|---|
| **Odoo** (Community/Enterprise) | POS + Inventory + Sales | Purchase, qayta buyurtma qoidalari, BI, Manufacturing | Eng to'liq ochiq ERP; qayta buyurtma qoidalari o'zida bor; self-host mumkin | Sozlash va hosting murakkab; kichik do'kon uchun og'ir |
| **Zoho Inventory / Books** | Ombor, buyurtma, hisob-faktura | Ko'p ombor, avtomatlashtirish, integratsiya | Arzon, Zoho ekotizimi | Mahalliy to'lov/soliq yo'q; POS alohida |
| **Square for Retail** | POS + ombor | Prognoz, xarid buyurtmalari, ko'p joy | Juda sodda | O'zbekistonda mavjudligi cheklangan |
| **Lightspeed Retail** | POS + ombor | Xarid buyurtmalari, tahlil, ko'p do'kon | Kuchli ombor va hisobotlar | Qimmat segment; mintaqada qo'llab-quvvatlash zaif |
| **Loyverse POS** | Bepul POS + ombor + kam qoldiq ogohlantirishi | Pullik qo'shimchalar (xodimlar, ombor kengaytmasi, integratsiyalar) | Boshlovchi uchun qulay | Tahlil va xarid avtomatlashtirishi sodda |
| **inFlow / Katana / Sortly** | Ombor boshqaruvi | Xarid buyurtmalari, shtrixkod, API | Ombor-markazli, qayta buyurtma nuqtalari | POS yo'q yoki cheklangan |

## 4. Bizning loyiha qayerda turadi

| Imkoniyat | Basic yechimlar | Pro yechimlar | **Bu loyiha (v0.2)** |
|---|---|---|---|
| Sotuvchi: sotuv | ✅ | ✅ | ✅ |
| Sotuvchi: kirim | ✅ | ✅ | ✅ |
| Sotuvchi: omborni ko'rish | ✅ | ✅ | ✅ (tannarx yashirin) |
| Admin: ombor holati | ✅ | ✅ | ✅ |
| Soatma-soat / kunma-kun tahlil | ⚠️ ko'pincha faqat kunlik | ✅ | ✅ |
| Mahsulot bo'yicha tahlil | ⚠️ | ✅ | ✅ (top, foyda, mahsulot filtri) |
| Kam qolgan mahsulotga xarid taklifi | ❌ (faqat ogohlantirish) | ✅ | ✅ sotuv tezligiga asoslangan, yetkazuvchi bo'yicha guruhlangan |
| Buyurtma → qabul → avto kirim | ❌ | ✅ | ✅ |
| Yetkazuvchi avansi / hisob-kitobi, kassa, foyda-zarar (xarajat, brak bilan), o'rtacha tannarx | ⚠️ ko'pincha faqat tushum | ✅ (Odoo, 1С, МойСклад) | ✅ ([batafsil](../README.md#moliya-foyda-daromad-kassa)) |
| Hujjatlar zanjiri (document flow), o'chirmaslik, storno, audit | ❌ | ✅ (SAP, Odoo, 1С — qisman) | ✅ ([batafsil](HUJJATLAR_ZANJIRI.md)) |
| Shtrixkod / chek printer | ✅ | ✅ | ✅ (klaviatura-skaner + brauzer orqali chop etish) |
| Ko'p filial / ombor | ❌ | ✅ | ❌ |
| Soliq/fiskal integratsiya | ✅ (mahalliy) | ✅ | ❌ |
| Offline rejim | ⚠️ | ✅ | ❌ |
| Qaytarish, chegirma, nasiya | ⚠️ | ✅ | ✅ |

**Xulosa.** Basic yechimlar arzon, lekin tahlil va xarid avtomatlashtirishi zaif; Pro yechimlar (Odoo, 1С, Smartup) murakkab va qimmat. Bu loyiha oradagi nuqtani nishonga oladi: kassa va ombor oddiy, tahlil va xarid taklifi Pro darajada.

## 5. Keyingi bosqichlar (ustuvorlik bo'yicha)

1. Soliq/fiskal integratsiya (O'zbekiston talablariga ko'ra).
2. Inventarizatsiya (haqiqiy qoldiq bilan solishtirish).
3. Xarid takliflarini Telegram orqali yetkazib beruvchiga yuborish.
4. ABC-tahlil va mavsumiy prognoz.
5. Offline rejim (PWA).
6. Ko'p filial.

_(Qaytarish, chegirma, nasiya, shtrixkod va chek chop etish v0.2 da qo'shildi.)_
