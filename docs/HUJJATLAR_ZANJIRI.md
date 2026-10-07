# Hujjatlar zanjiri (document flow)

Tizimdagi har bir hujjat o'zi kelib chiqqan hujjatga, ombor/qarz daftariga va qatorlariga **bazada** bog'langan. Shu tufayli:

- **yo'qdan bor bo'lmaydi** — qoldiq yoki qarz hujjatsiz paydo bo'lmaydi;
- **bordan yo'q bo'lmaydi** — hech narsa o'chirilmaydi, hujjat o'zgarmaydi, tuzatish faqat teskari hujjat bilan.

Umumiy qoidalar va aktiv/noaktiv holat: [README → Ma'lumot yaxlitligi](../README.md#malumot-yaxlitligi-sap-tamoyillari). Bozordagi yechimlar bilan taqqoslash: [BOZOR_TAHLILI.md](BOZOR_TAHLILI.md).

## Xarita

```mermaid
flowchart LR
  PO[Buyurtma<br/>purchase_orders] -- po_id --> R[Kirim<br/>receipts: receipt]
  OP[Boshlang'ich qoldiq<br/>receipts: opening] --> M
  R -- ref_receipt_id --> RV[Kirim storno<br/>receipts: reversal]
  R --> M[(Ombor daftari<br/>stock_moves)]
  RV --> M
  S[Sotuv<br/>sales: sale] --> M
  S -- ref_sale_id --> RT[Qaytarish<br/>sales: return]
  RT --> M
  M ==> ST[products.stock]
  S -- nasiya --> L[(Mijoz daftari<br/>customer_ledger)]
  RT -- qarzga --> L
  P[Qarz to'lovi<br/>debt_payments] --> L
  L ==> B[customers.balance]
```

`==>` — qoldiq/qarz **faqat** daftar orqali o'zgaradi (to'g'ridan-to'g'ri `UPDATE` bazada rad etiladi).

## Har bir hujjat

| Hujjat | Jadval | Nimaga bog'liq | Ombor/qarzga ta'siri | Tuzatish usuli |
|---|---|---|---|---|
| Buyurtma | `purchase_orders` + `po_items` | yetkazib beruvchi | yo'q (faqat reja) | holat: `ordered` → `received`/`cancelled` |
| Kirim | `receipts` (`receipt`) + `receipt_items` | buyurtma (`po_id`, ixtiyoriy), yetkazuvchi | ombor `+` (`receipt` / `purchase`) | storno (admin) |
| Boshlang'ich qoldiq | `receipts` (`opening`) | mahsulot yaratilganda | ombor `+` (`opening`) | storno qilinmaydi — yangi tuzatuvchi kirim/sotuv |
| Kirim storno | `receipts` (`reversal`) | asl kirim (`ref_receipt_id`, bitta) | ombor `−` (`receipt_reversal`) | — (takror storno taqiqlangan) |
| Sotuv | `sales` (`sale`) + `sale_items` | mijoz (nasiyada majburiy) | ombor `−` (`sale`); nasiya bo'lsa mijoz daftari `+` | qaytarish |
| Qaytarish | `sales` (`return`) + `sale_items` | asl sotuv (`ref_sale_id`), asl qator (`orig_item_id`) | ombor `+` (`return`); qarzga bo'lsa mijoz daftari `−` | — |
| Qarz to'lovi | `debt_payments` | mijoz | mijoz daftari `−` | — |

## Bazada majburlanadigan qoidalar

| # | Qoida | Buzilsa |
|---|---|---|
| 1 | Hech qaysi jadvaldan qator o'chirilmaydi (`DELETE`/`TRUNCATE`) | xato, tranzaksiya bekor |
| 2 | Hujjat yozilgach o'zgarmaydi (`UPDATE` taqiq); buyurtmada faqat holat | xato |
| 3 | Ombor harakati aynan **bitta** hujjatga bog'langan (`sale_id` yoki `receipt_id`), turi hujjatga mos | `CHECK` xato |
| 4 | `products.stock` va `customers.balance` faqat daftar yozuvi orqali; manfiy bo'la olmaydi | xato / "Omborda yetarli emas" |
| 5 | Hujjat jami = qatorlar yig'indisi; hujjatda kamida bitta qator | tranzaksiya oxirida rad |
| 6 | Hujjat qatorlari = ombor harakatlari (mahsulot bo'yicha miqdor teng) | tranzaksiya oxirida rad |
| 7 | Nasiya summasi (`jami − to'langan`) = mijoz daftaridagi yozuv; qarz to'lovi daftarda ko'rinishi shart | tranzaksiya oxirida rad |
| 8 | Qaytarish asl sotuv qatoriga mos, miqdor va summa bo'yicha sotilganidan oshmaydi | xato |
| 9 | Storno asl kirimning aynan teskarisi; buyurtma kirim hujjatisiz `received` bo'lmaydi; buyurtma bo'yicha kirim buyurtma qatorlariga teng | xato |
| 10 | Asosiy ma'lumot (mahsulot, mijoz, yetkazuvchi, foydalanuvchi) o'zgarishi `change_log` ga yoziladi | — |

5–7 va 9 qoidalar `DEFERRED` constraint trigger'lar: hujjat sarlavhasi va qatorlari bir tranzaksiyada yoziladi, tekshiruv `COMMIT` paytida bajariladi. Xato bo'lsa butun hujjat yozilmaydi — yarim holatdagi hujjat qolmaydi.

## Ko'rish va nazorat (admin)

- **Hujjatlar** bo'limi: hujjat turini va raqamini kiriting (yoki Sotuvlar / Buyurtmalar / Kirim ro'yxatidagi **Zanjir** tugmasi) — hujjat, qatorlari, ombor harakatlari, mijoz daftari va bog'liq hujjatlar (bosib o'tish mumkin) ko'rinadi. API: `GET /api/admin/document-flow?type=sale|receipt|po|payment&id=N`.
- **Yaxlitlik nazorati** (xuddi shu bo'limda, **Tekshirish**): 11 ta solishtirish — qoldiq ↔ ombor daftari, qarz ↔ mijoz daftari, hujjat jami ↔ qatorlar, qatorlar ↔ harakatlar, buyurtma ↔ kirim va h.k. API: `GET /api/admin/integrity`. Bazaga qoidalarni chetlab o'tib yozilgan (masalan, trigger o'chirilgan) bo'lsa ham, bu hisobot buzilishni topadi.
- **Tarix** bo'limi: asosiy ma'lumotlar o'zgarishi (kim, qachon, eski → yangi).

## Hujjat misollari

**Buyurtma → kirim → storno.** Buyurtma #1 (6 ta Non) "Qabul qilindi" bosilganda: kirim #4 yaratiladi (`po_id=1`), ombor daftariga `+6` (`purchase`) yoziladi, buyurtma `received` bo'ladi (kirim hujjati bo'lmasa baza buni rad etadi). Xato bo'lsa kirim stornosi: kirim #5 (`reversal`, `ref_receipt_id=4`), ombor `−6`. Asl kirim #4 o'zgarmaydi; ikkinchi storno taqiqlangan; tovar allaqachon sotilgan bo'lsa storno rad etiladi.

**Sotuv → qaytarish → to'lov.** Sotuv #10: 3 dona, 10 800 so'm, 800 to'langan → ombor `−3`, mijoz daftari `+10 000`. Qaytarish #11 (`ref_sale_id=10`, 1 dona, 3 600): ombor `+1`, qarzga o'tkazilsa mijoz daftari `−3 600`. To'lov #1 (1 000): mijoz daftari `−1 000`. Mijoz qarzi = `10 000 − 3 600 − 1 000 = 5 400`.
