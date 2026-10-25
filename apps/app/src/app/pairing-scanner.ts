import { Capacitor } from '@capacitor/core';
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { PairingScannerPort } from '@open-record/state';

/**
 * QR scanning through ML Kit (`@capacitor-mlkit/barcode-scanning`). Native
 * only: on the web there is no pairing scanner and the Settings button is hidden.
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
      throw new Error('Camera access is off. Allow it in system settings to scan.');
    }

    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    return barcodes.find((b) => b.rawValue)?.rawValue ?? null;
  }
}
