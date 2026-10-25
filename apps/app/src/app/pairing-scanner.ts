import { Capacitor } from '@capacitor/core';
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { PairingScannerPort } from '@open-record/state';

const CAMERA_OFF = 'Camera access is off. Allow it in system settings to scan.';

/**
 * QR scanning through ML Kit (`@capacitor-mlkit/barcode-scanning`). Android
 * only: the plugin has no Swift Package, so it is not linked on iOS (SPM).
 */
export class BarcodePairingScanner extends PairingScannerPort {
  async available(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    try {
      return (await BarcodeScanner.isSupported()).supported;
    } catch {
      return false;
    }
  }

  async scan(): Promise<string | null> {
    if (Capacitor.getPlatform() === 'android') {
      const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (!available) {
        // Installation starts with this call; the user retries once it finishes.
        await BarcodeScanner.installGoogleBarcodeScannerModule();
        throw new Error('Downloading the scanner module. Try again in a moment.');
      }
    }

    let { camera } = await BarcodeScanner.checkPermissions();
    if (camera !== 'granted' && camera !== 'limited') {
      ({ camera } = await BarcodeScanner.requestPermissions());
    }
    if (camera !== 'granted' && camera !== 'limited') {
      throw new Error(CAMERA_OFF);
    }

    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    return barcodes.find((b) => b.rawValue)?.rawValue ?? null;
  }
}

/** Frame decode interval (~8 fps). */
const FRAME_MS = 125;
/** Longest side of the decoded frame; smaller frames decode faster. */
const MAX_FRAME = 640;
const STYLE_ID = 'or-qr-scanner-style';

const STYLES = `
.or-qr-scanner {
  position: fixed; inset: 0; z-index: 1000;
  display: grid; place-items: center;
  padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  background: rgba(9, 11, 14, 0.68);
  animation: or-qr-in var(--duration-base, 200ms) var(--ease-standard, cubic-bezier(.23,1,.32,1));
}
.or-qr-scanner__card {
  display: grid; gap: 12px;
  width: 100%; max-width: 336px; padding: 16px;
  background: var(--color-surface); color: var(--color-text);
  border: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
  border-radius: var(--rounded-md, 8px);
  box-shadow: 0 24px 50px rgba(0, 0, 0, 0.55);
}
.or-qr-scanner__title {
  margin: 0; font-family: var(--font-display); font-size: 20px; font-weight: 600; line-height: 1.25;
}
.or-qr-scanner__hint { margin: 0; color: var(--color-muted); font-size: 13px; }
.or-qr-scanner__video {
  display: block; width: 100%; aspect-ratio: 1; object-fit: cover;
  background: var(--color-vinyl); border-radius: var(--rounded-md, 8px);
}
.or-qr-scanner__cancel {
  min-height: 44px; padding: 0 16px; font: inherit; font-size: 15px;
  color: var(--color-text); background: var(--color-surface);
  border: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
  border-radius: var(--rounded-md, 8px); cursor: pointer;
  transition: background-color var(--duration-fast, 140ms) var(--ease-standard, ease);
}
.or-qr-scanner__cancel:hover { background: var(--color-surface-raised); }
.or-qr-scanner__cancel:active { transform: scale(0.97); }
.or-qr-scanner__cancel:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
@keyframes or-qr-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .or-qr-scanner { animation: none; }
  .or-qr-scanner__cancel { transition: none; }
}
`;

/**
 * In-webview QR scanning: `getUserMedia` camera feed in a full-screen overlay,
 * frames decoded with jsQR. Used on iOS (WKWebView, iOS 14.3+) and the web.
 */
export class WebPairingScanner extends PairingScannerPort {
  async available(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
    return Capacitor.isNativePlatform() || window.isSecureContext;
  }

  async scan(): Promise<string | null> {
    const decode = (await import('jsqr')).default;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error(CAMERA_OFF);
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new Error('No camera found on this device.');
      }
      throw new Error('Could not start the camera. Try again.');
    }

    const ui = buildOverlay();
    const opener = document.activeElement as HTMLElement | null;
    document.body.appendChild(ui.root);
    ui.cancel.focus();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    return new Promise<string | null>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;

      const finish = (result: string | null, error?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stream.getTracks().forEach((t) => t.stop());
        ui.video.srcObject = null;
        ui.root.removeEventListener('keydown', onKey);
        ui.root.remove();
        opener?.focus?.();
        if (error) reject(error);
        else resolve(result);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') finish(null);
        // Keep focus inside the dialog (its only control is Cancel).
        if (e.key === 'Tab') {
          e.preventDefault();
          ui.cancel.focus();
        }
      };

      const tick = (): void => {
        if (done) return;
        const { video } = ui;
        if (ctx && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth) {
          const scale = Math.min(1, MAX_FRAME / Math.max(video.videoWidth, video.videoHeight));
          const w = Math.round(video.videoWidth * scale);
          const h = Math.round(video.videoHeight * scale);
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const code = decode(ctx.getImageData(0, 0, w, h).data, w, h, {
            inversionAttempts: 'dontInvert',
          });
          if (code?.data) return finish(code.data);
        }
        timer = setTimeout(tick, FRAME_MS);
      };

      ui.cancel.addEventListener('click', () => finish(null));
      ui.root.addEventListener('keydown', onKey);
      ui.video.srcObject = stream;
      ui.video.play().then(tick, () =>
        finish(null, new Error('Could not start the camera. Try again.')),
      );
    });
  }
}

/**
 * Picks ML Kit on Android and the in-webview scanner everywhere else (iOS
 * cannot link the ML Kit plugin through SPM).
 */
export class PlatformPairingScanner extends PairingScannerPort {
  private readonly impl: PairingScannerPort =
    Capacitor.getPlatform() === 'android' ? new BarcodePairingScanner() : new WebPairingScanner();

  available(): Promise<boolean> {
    return this.impl.available();
  }

  scan(): Promise<string | null> {
    return this.impl.scan();
  }
}

function buildOverlay(): {
  root: HTMLElement;
  video: HTMLVideoElement;
  cancel: HTMLButtonElement;
} {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  const root = document.createElement('div');
  root.className = 'or-qr-scanner';

  const card = document.createElement('div');
  card.className = 'or-qr-scanner__card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'or-qr-scanner-title');

  const title = document.createElement('h2');
  title.id = 'or-qr-scanner-title';
  title.className = 'or-qr-scanner__title';
  title.textContent = 'Scan pairing code';

  const hint = document.createElement('p');
  hint.className = 'or-qr-scanner__hint';
  hint.textContent = 'Point the camera at the QR code shown by your server.';

  const video = document.createElement('video');
  video.className = 'or-qr-scanner__video';
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.setAttribute('aria-label', 'Camera preview');

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'or-qr-scanner__cancel';
  cancel.textContent = 'Cancel';

  card.append(title, hint, video, cancel);
  root.appendChild(card);
  return { root, video, cancel };
}
