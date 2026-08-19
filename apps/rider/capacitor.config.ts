import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.easybuydelivery.rider',
  appName: 'Easy Buy Rider',
  webDir: 'dist',
  // Point the wrapped webview at the deployed rider app, or bundle `dist`.
  // server: { url: 'https://ebd-rider.vercel.app', cleartext: false },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
