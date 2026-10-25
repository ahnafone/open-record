import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.openrecord',
  appName: 'Open Record',
  // Nx build output of `nx build app` (Angular application builder writes to <outputPath>/browser).
  webDir: '../../dist/apps/app/browser',
  backgroundColor: '#171b20',
};

export default config;
