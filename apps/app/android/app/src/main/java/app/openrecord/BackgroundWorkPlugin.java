package app.openrecord;

import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Starts, updates and stops {@link DownloadService} so downloads keep going
 * with the screen off. Used by apps/app/src/app/background-work.ts; the JS
 * side asks for POST_NOTIFICATIONS (NotificationPermissionPlugin) first.
 * start() rejects when Android refuses a foreground service (for example
 * when started from the background on Android 12+).
 */
@CapacitorPlugin(name = "BackgroundWork")
public class BackgroundWorkPlugin extends Plugin {

    private String title = "Open Record";
    /** JS wants the hold (between start and stop). */
    private boolean running = false;
    /** The app's activity is in the foreground (a restart is allowed). */
    private boolean resumed = true;
    private String lastText = "Downloading";

    @PluginMethod
    public void start(PluginCall call) {
        title = call.getString("title", "Open Record");
        String text = call.getString("text", "Downloading");
        lastText = text;
        // The hold is wanted from now on, even if Android refuses it now.
        running = true;
        if (startService(text)) call.resolve();
        else call.reject("Could not start background downloads.");
    }

    /**
     * Start (or refresh) the foreground service. False when Android refuses,
     * e.g. from the background on Android 12+ or after the Android 15
     * dataSync time limit until the app is opened again.
     */
    private boolean startService(String text) {
        Context context = getContext();
        Intent intent = new Intent(context, DownloadService.class)
            .putExtra(DownloadService.EXTRA_TITLE, title)
            .putExtra(DownloadService.EXTRA_TEXT, text);
        try {
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (RuntimeException e) {
            // ForegroundServiceStartNotAllowedException (API 31+) or IllegalStateException.
            return false;
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        lastText = call.getString("text", "Downloading");
        if (running && !DownloadService.active) {
            // Android ended the service (time limit) or refused it earlier:
            // start it again, only from the foreground where Android allows it.
            if (resumed) startService(lastText);
        } else if (running) {
            Context context = getContext();
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(
                    DownloadService.NOTIFICATION_ID,
                    DownloadService.buildNotification(context, title, lastText)
                );
            }
        }
        call.resolve();
    }

    /** `{ ignoring }`: the app is exempt from battery optimization (Doze cuts its network otherwise). */
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        call.resolve(batteryResult(isExempt()));
    }

    /**
     * Opens the system "Don't optimize" dialog for this app (no new UI). Resolves
     * with `{ ignoring }` once the dialog closes; the JS side asks only once.
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        if (isExempt()) {
            call.resolve(batteryResult(true));
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:" + getContext().getPackageName()));
        try {
            startActivityForResult(call, intent, "onBatteryOptimizationResult");
        } catch (ActivityNotFoundException e) {
            call.resolve(batteryResult(false));
        }
    }

    @ActivityCallback
    private void onBatteryOptimizationResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        call.resolve(batteryResult(isExempt()));
    }

    private boolean isExempt() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private static JSObject batteryResult(boolean ignoring) {
        JSObject result = new JSObject();
        result.put("ignoring", ignoring);
        return result;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        getContext().stopService(new Intent(getContext(), DownloadService.class));
        call.resolve();
    }

    @Override
    protected void handleOnResume() {
        resumed = true;
        if (running && !DownloadService.active) startService(lastText);
    }

    @Override
    protected void handleOnPause() {
        resumed = false;
    }

    @Override
    protected void handleOnDestroy() {
        running = false;
        getContext().stopService(new Intent(getContext(), DownloadService.class));
    }
}
