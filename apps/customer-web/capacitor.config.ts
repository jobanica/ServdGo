import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The customer app, wrapped for Google Play.
 *
 * The web assets are bundled rather than loaded from the deployment, so the app
 * opens instantly and doesn't depend on a hosting URL we might change. It still
 * talks to Supabase over the network like the website does — the only thing
 * that ships inside the APK is the interface.
 */
const config: CapacitorConfig = {
  appId: 'com.easybuydelivery.customer',
  appName: 'Easy Buy Delivery',
  webDir: 'dist',
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
