package app.openrecord;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.view.KeyEvent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Media (STREAM_MUSIC) volume as a 0..1 fraction of the stream's step count.
 * setVolume passes no flags, so no system volume panel appears.
 *
 * volumeChanged fires for any music-stream change (hardware keys, system UI,
 * setVolume), deduped by step index. While key intercept is on, the hardware
 * volume keys are consumed by MainActivity and reported as volumeKey instead
 * of changing the system volume.
 */
@CapacitorPlugin(name = "SystemVolume")
public class SystemVolumePlugin extends Plugin {

    private static final String VOLUME_CHANGED_ACTION = "android.media.VOLUME_CHANGED_ACTION";
    private static final String EXTRA_STREAM_TYPE = "android.media.EXTRA_VOLUME_STREAM_TYPE";

    private AudioManager audio;
    private BroadcastReceiver receiver;
    private int lastIndex = -1;
    private volatile boolean keyIntercept;

    @Override
    public void load() {
        audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        lastIndex = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!VOLUME_CHANGED_ACTION.equals(intent.getAction())) {
                    return;
                }
                if (intent.getIntExtra(EXTRA_STREAM_TYPE, -1) != AudioManager.STREAM_MUSIC) {
                    return;
                }
                emitVolumeIfChanged();
            }
        };
        // System broadcast: a non-exported receiver still receives it.
        ContextCompat.registerReceiver(
            getContext(),
            receiver,
            new IntentFilter(VOLUME_CHANGED_ACTION),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    protected void handleOnDestroy() {
        // Keys go back to the OS once the plugin is gone.
        keyIntercept = false;
        if (receiver != null) {
            getContext().unregisterReceiver(receiver);
            receiver = null;
        }
    }

    @PluginMethod
    public void getVolume(PluginCall call) {
        JSObject out = new JSObject();
        out.put("volume", fraction(audio.getStreamVolume(AudioManager.STREAM_MUSIC)));
        // Fixed-volume devices ignore setStreamVolume: the app must not offer control.
        out.put("fixed", audio.isVolumeFixed());
        call.resolve(out);
    }

    @Override
    protected void handleOnResume() {
        // The level may have changed while the app was in the background.
        emitVolumeIfChanged();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double requested = call.getDouble("volume");
        if (requested == null || requested.isNaN()) {
            call.reject("volume is required.");
            return;
        }
        double clamped = Math.min(1d, Math.max(0d, requested));
        int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int index = (int) Math.round(clamped * max);
        try {
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, index, 0);
        } catch (SecurityException e) {
            call.reject("Volume could not be changed: " + e.getMessage(), e);
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void setKeyIntercept(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("enabled is required.");
            return;
        }
        keyIntercept = enabled;
        call.resolve();
    }

    /**
     * Called by MainActivity for volume key events. Returns true when the key
     * is consumed (intercept on), so the system volume is left unchanged.
     */
    boolean onVolumeKey(int keyCode, boolean down) {
        if (!keyIntercept) {
            return false;
        }
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
            return false;
        }
        if (down) {
            JSObject data = new JSObject();
            data.put("direction", keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down");
            notifyListeners("volumeKey", data);
        }
        return true;
    }

    private void emitVolumeIfChanged() {
        int index = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
        if (index == lastIndex) {
            return;
        }
        lastIndex = index;
        JSObject data = new JSObject();
        data.put("volume", fraction(index));
        notifyListeners("volumeChanged", data);
    }

    private double fraction(int index) {
        int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        return max <= 0 ? 0d : (double) index / max;
    }
}
