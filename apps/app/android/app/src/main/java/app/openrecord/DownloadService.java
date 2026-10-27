package app.openrecord;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Foreground service (type dataSync) that keeps the app process, CPU and
 * Wi-Fi awake while the WebView downloads songs, so auto-downloads continue
 * with the screen off. It does no work itself: the JS download loop runs as
 * before and starts/stops this through {@link BackgroundWorkPlugin}. Shows a
 * low-importance ongoing notification ("Downloading · N left").
 */
public class DownloadService extends Service {

    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String CHANNEL_ID = "downloads";
    static final int NOTIFICATION_ID = 4107;
    private static final String LOCK_TAG = "OpenRecord:downloads";
    /** Safety net: the hold is released after this even if JS never calls stop. */
    private static final long MAX_HOLD_MS = 6L * 60 * 60 * 1000;

    /**
     * True while the service is in the foreground. Cleared when Android ends
     * it (dataSync time limit) so the plugin knows to start it again instead
     * of re-posting a notification for a service that is gone.
     */
    static volatile boolean active = false;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        Notification notification = buildNotification(this, title, text);
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
        } catch (RuntimeException e) {
            // Not allowed now (e.g. the dataSync time limit is used up): give up
            // quietly; downloads still run while the app is open.
            active = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        active = true;
        acquireLocks();
        // Not restarted after the process dies: the JS queue is gone with it.
        return START_NOT_STICKY;
    }

    /**
     * Android 15+: dataSync services get a 6 h daily time limit. Stop at once
     * (Android crashes the app if the service outlives the timeout); the
     * plugin starts it again on the next update once the app is in the
     * foreground and the limit has reset.
     */
    @Override
    public void onTimeout(int startId, int fgsType) {
        active = false;
        releaseLocks();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        active = false;
        releaseLocks();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @SuppressWarnings("deprecation")
    private void acquireLocks() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, LOCK_TAG);
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(MAX_HOLD_MS);
            }
        }
        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, LOCK_TAG);
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        }
    }

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wifiLock = null;
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while songs download to this device.");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }

    static Notification buildNotification(Context context, String title, String text) {
        ensureChannel(context);
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent content = open == null
            ? null
            : PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title != null ? title : "Open Record")
            .setContentText(text != null ? text : "Downloading")
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }
}
