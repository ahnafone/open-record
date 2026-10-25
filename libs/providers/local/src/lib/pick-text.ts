import { Capacitor } from '@capacitor/core';
import { FilePicker } from '@capawesome/capacitor-file-picker';

/** Spotify exports: Exportify CSV or data-download JSON (zip is not read). */
const TYPES = ['text/csv', 'text/comma-separated-values', 'application/json', 'text/plain'];
const ACCEPT = '.csv,.json,text/csv,application/json';

export interface PickedTextFile {
  name: string;
  text: string;
}

function isCancel(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(message);
}

/**
 * Let the user pick one .csv or .json file and read it as text. Resolves null
 * when the picker is dismissed. Native: system document picker; web:
 * `<input type=file>` (call from a user gesture).
 */
export async function pickTextFile(): Promise<PickedTextFile | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { files } = await FilePicker.pickFiles({ types: TYPES, limit: 1, readData: true });
      const file = files[0];
      if (!file) return null;
      const text = file.blob ? await file.blob.text() : decodeBase64(file.data ?? '');
      return { name: file.name, text };
    } catch (err) {
      if (isCancel(err)) return null;
      throw err;
    }
  }
  return pickWithInput();
}

function decodeBase64(data: string): string {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function pickWithInput(): Promise<PickedTextFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.style.display = 'none';
    const done = (result: PickedTextFile | null) => {
      input.remove();
      resolve(result);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      file.text().then(
        (text) => done({ name: file.name, text }),
        (err) => {
          input.remove();
          reject(err);
        },
      );
    });
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
