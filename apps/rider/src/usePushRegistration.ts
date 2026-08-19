import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { saveRiderPushToken } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';

/**
 * Register the device for push (native only) and store the FCM/APNs token so the
 * server can notify this rider of incoming orders while the app is closed.
 * The actual send is a server-side Edge Function (see supabase/functions).
 */
export function usePushRegistration(riderId: string | undefined, enabled = true) {
  useEffect(() => {
    if (!enabled || !Capacitor.isNativePlatform() || !supabase || !riderId) return;

    const platform = Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';

    const tokenSub = PushNotifications.addListener('registration', (token) => {
      void saveRiderPushToken(supabase!, riderId, token.value, platform);
    });
    const errSub = PushNotifications.addListener('registrationError', (e) => {
      console.warn('push registration error', e);
    });

    (async () => {
      let perm = await PushNotifications.checkPermissions();
      if (perm.receive === 'prompt') perm = await PushNotifications.requestPermissions();
      if (perm.receive === 'granted') await PushNotifications.register();
    })();

    return () => {
      void tokenSub.then((s) => s.remove());
      void errSub.then((s) => s.remove());
    };
  }, [riderId, enabled]);
}
