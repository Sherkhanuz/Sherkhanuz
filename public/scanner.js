// Kamera orqali shtrixkod/QR skaneri. Chrome/Android'da o'rnatilgan BarcodeDetector, boshqa brauzerlarda (iOS Safari)
// /vendor/zxing.min.js (ZXing) ishlatiladi. Kamera faqat HTTPS (yoki localhost) da ishlaydi.
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'];

let zxingLoading;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/zxing.min.js';
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => { zxingLoading = null; reject(new Error('Skaner kutubxonasi yuklanmadi')); };
    document.head.append(s);
  });
  return zxingLoading;
}

async function makeDecoder(video) {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        const det = new window.BarcodeDetector({ formats });
        return async () => (await det.detect(video))[0]?.rawValue || null;
      }
    } catch { /* ZXing ga o'tamiz */ }
  }
  const Z = await loadZXing();
  const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A,
    Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF, Z.BarcodeFormat.CODABAR, Z.BarcodeFormat.QR_CODE]],
    [Z.DecodeHintType.TRY_HARDER, true]]);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async () => {
    if (!video.videoWidth) return null;
    // Kadrni kichraytiramiz: tezroq va barqarorroq
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
      return reader.decode(bmp).getText();
    } catch { return null; } // NotFoundException — kadrda kod yo'q
  };
}

function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const a = new AC(); const o = a.createOscillator(); const g = a.createGain();
    o.frequency.value = 1100; g.gain.value = 0.08; o.connect(g); g.connect(a.destination);
    o.start(); setTimeout(() => { o.stop(); a.close(); }, 90);
  } catch { /* ovozsiz */ }
}

const cameraError = (e) => {
  if (!navigator.mediaDevices?.getUserMedia) return 'Kamera faqat HTTPS (xavfsiz ulanish) orqali ishlaydi';
  if (e?.name === 'NotAllowedError') return 'Kameraga ruxsat berilmadi. Brauzer sozlamalarida ruxsat bering';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'Kamera topilmadi';
  if (e?.name === 'NotReadableError') return 'Kamera boshqa ilova tomonidan band';
  return e?.message || 'Kamerani ochib bo\'lmadi';
};

/**
 * Skanerni ochadi (to'liq ekran): tepada holat/chiroq, o'rtada kamera va ramka, pastda `panel` (chaqiruvchi
 * yangilab turadigan DOM — masalan jonli savat). Skaner yopilmaydi: ketma-ket bir nechta mahsulot skanerlanadi.
 *   onCode(code) -> { ok, msg }   natija tepadagi holat satrida ko'rsatiladi
 * Qaytaradi: { close, notify(msg, ok) }
 */
export function openScanner({ onCode, onClose, panel, title = 'Skaner' }) {
  const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, attrs); n.append(...kids.filter((k) => k != null)); return n; };
  const video = el('video', { playsInline: true, muted: true, autoplay: true, className: 'scan-video' });
  const status = el('div', { className: 'scan-status', textContent: 'Kamera ochilmoqda...' });
  const closeBtn = el('button', { className: 'scan-icon', type: 'button', textContent: '✕', ariaLabel: 'Yopish' });
  const torchBtn = el('button', { className: 'scan-icon', type: 'button', textContent: '🔦', hidden: true, ariaLabel: 'Chiroq' });
  const kbBtn = el('button', { className: 'scan-icon', type: 'button', textContent: '⌨', ariaLabel: 'Kodni qo\'lda kiritish' });
  const manual = el('input', { placeholder: 'Kodni kiriting va Enter bosing', inputMode: 'numeric', className: 'scan-manual' });
  const manualWrap = el('div', { className: 'scan-manualwrap', hidden: true }, manual);
  const reticle = el('div', { className: 'scan-reticle' }, el('i', { className: 'c tl' }), el('i', { className: 'c tr' }), el('i', { className: 'c bl' }), el('i', { className: 'c br' }), el('b', { className: 'scan-line' }));
  const top = el('div', { className: 'scan-top' }, closeBtn, el('div', { className: 'scan-title', textContent: title }), torchBtn, kbBtn);
  const sheet = el('div', { className: 'scan-sheet' }, panel);
  const overlay = el('div', { className: 'scan-overlay', role: 'dialog', ariaLabel: 'Shtrixkod skaneri' }, video, reticle, top, status, manualWrap, sheet);
  document.body.append(overlay);
  document.body.classList.add('scanning');

  let stream, stopped = false, timer, last = { code: null, seen: 0 }, torchOn = false, statusTimer;
  const notify = (msg, ok) => {
    status.textContent = msg; status.className = 'scan-status show ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
    clearTimeout(statusTimer);
    if (ok !== undefined) statusTimer = setTimeout(() => { status.className = 'scan-status'; }, 2200);
    if (ok === true) { reticle.classList.remove('hit'); void reticle.offsetWidth; reticle.classList.add('hit'); beep(); navigator.vibrate?.(60); }
    if (ok === false) navigator.vibrate?.([40, 40, 40]);
  };
  const handle = async (code) => {
    const now = Date.now();
    // Kod ramkada turgan ekan, qayta qo'shilmaydi; ramkadan chiqib (1.2 s ko'rinmay), yana kirsa — yangi dona
    const same = code === last.code && now - last.seen < 1200;
    last = { code, seen: now };
    if (same) return;
    const r = await onCode(code);
    notify(r.msg, r.ok);
  };
  function close() {
    if (stopped) return; stopped = true;
    clearTimeout(timer); clearTimeout(statusTimer);
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove(); document.body.classList.remove('scanning');
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  closeBtn.onclick = close;
  kbBtn.onclick = () => { manualWrap.hidden = !manualWrap.hidden; if (!manualWrap.hidden) manual.focus(); };
  manual.addEventListener('keydown', (e) => { if (e.key === 'Enter' && manual.value.trim()) { last = { code: null, seen: 0 }; handle(manual.value.trim()); manual.value = ''; } });
  torchBtn.onclick = async () => {
    torchOn = !torchOn;
    try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] }); torchBtn.classList.toggle('on', torchOn); } catch { torchOn = false; }
  };

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play();
      torchBtn.hidden = !stream.getVideoTracks()[0].getCapabilities?.().torch;
      const decode = await makeDecoder(video);
      notify('Shtrixkodni ramkaga to\'g\'rilang');
      const tick = async () => {
        if (stopped) return;
        try { const code = await decode(); if (code && !stopped) await handle(code); } catch { /* keyingi kadr */ }
        timer = setTimeout(tick, 120);
      };
      tick();
    } catch (e) {
      notify(cameraError(e), false);
      clearTimeout(statusTimer); // xato xabari yo'qolmasin
      manualWrap.hidden = false; manual.focus(); // kamera bo'lmasa ham qo'lda kiritish ishlaydi
    }
  })();
  return { close, notify };
}
