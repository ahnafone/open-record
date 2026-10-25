import { Capacitor } from '@capacitor/core';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import type { PickedAudio } from './file-store';

const ACCEPT = 'audio/*';

function isCancel(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(message);
}

/**
 * Let the user pick one or more audio files. Resolves to an empty array when
 * the picker is dismissed. Native: system document picker; web: `<input type=file>`.
 * On the web this must be called from a user gesture (click handler).
 */
export async function pickAudioFiles(): Promise<PickedAudio[]> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { files } = await FilePicker.pickFiles({ types: [ACCEPT], limit: 0, readData: false });
      return files.map((f) => ({ name: f.name, mimeType: f.mimeType || undefined, size: f.size, path: f.path, blob: f.blob }));
    } catch (err) {
      if (isCancel(err)) return [];
      throw err;
    }
  }
  return pickWithInput();
}

function pickWithInput(): Promise<PickedAudio[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.multiple = true;
    input.style.display = 'none';
    const done = (files: PickedAudio[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () =>
      done(
        Array.from(input.files ?? []).map((f) => ({
          name: f.name,
          mimeType: f.type || undefined,
          size: f.size,
          blob: f,
        })),
      ),
    );
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}
