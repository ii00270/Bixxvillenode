// QR on screen and QR through the camera. The two small libraries are loaded on first use from
// pinned versions (the service worker saves them, so they work offline once seen).

export const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';    // qrcode-generator 1.4.4
export const SCAN_LIB = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';                          // jsQR 1.4.0

const loaded = new Map();
function script(url, test) {
  if (test()) return Promise.resolve();
  if (!loaded.has(url)) loaded.set(url, new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = url; s.onload = () => res(); s.onerror = () => { loaded.delete(url); rej(new Error('A needed library could not load. Connect once so the app can save it.')); };
    document.head.appendChild(s);
  }));
  return loaded.get(url);
}
export const loadQr = () => script(QR_LIB, () => !!window.qrcode);
export const loadScan = () => script(SCAN_LIB, () => !!window.jsQR);

export function qrSvg(text, px = 260) {
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }).replace('<svg ', `<svg width="${px}" height="${px}" style="background:#fff" `);
}

// Shows frames one after another, looping, a few per second.
export class QrPlayer {
  constructor(el, frames, { fps = 3, px = 280 } = {}) { Object.assign(this, { el, frames, fps, px, i: 0, timer: 0, onTick: null }); }
  async start() {
    await loadQr();
    const draw = () => { this.el.innerHTML = qrSvg(this.frames[this.i], this.px); this.onTick?.(this.i + 1, this.frames.length); this.i = (this.i + 1) % this.frames.length; };
    draw();
    if (this.frames.length > 1) this.timer = setInterval(draw, 1000 / this.fps);
  }
  stop() { clearInterval(this.timer); this.timer = 0; }
}

export const cameraAvailable = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

// Reads QR codes from the camera. BarcodeDetector where the browser has it, jsQR otherwise.
export class QrScanner {
  constructor(video, onText) { Object.assign(this, { video, onText, stream: null, raf: 0, last: '', lastAt: 0 }); }
  async start() {
    if (!cameraAvailable()) throw new Error('This browser cannot use the camera. Paste the code instead.');
    const det = window.BarcodeDetector ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    if (!det) await loadScan();
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    this.video.srcObject = this.stream; await this.video.play();
    const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (!this.stream) return;
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) {
        let text = null;
        try {
          if (det) text = (await det.detect(v))[0]?.rawValue || null;
          if (!text) {
            const w = Math.min(720, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth); cv.width = w; cv.height = h; cx.drawImage(v, 0, 0, w, h);
            text = window.jsQR?.(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })?.data || null;
          }
        } catch (e) { /* a bad frame; try the next */ }
        if (text && (text !== this.last || Date.now() - this.lastAt > 1500)) { this.last = text; this.lastAt = Date.now(); this.onText(text); }
      }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  stop() { cancelAnimationFrame(this.raf); this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; }
}
