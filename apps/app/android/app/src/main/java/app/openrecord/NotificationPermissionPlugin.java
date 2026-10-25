package app.openrecord;

import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Requests POST_NOTIFICATIONS (Android 13+) so the background-playback
 * notification from capacitor-plugin-playlist is visible. Used by
 * libs/player before the first native playback. Below Android 13 the
 * permission is granted at install time.
 */
@CapacitorPlugin(
    name = "NotificationPermission",
    permissions = {
        @Permission(alias = NotificationPermissionPlugin.ALIAS, strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class NotificationPermissionPlugin extends Plugin {

    static final String ALIAS = "notifications";

    @PluginMethod
    public void request(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState(ALIAS) == PermissionState.GRANTED) {
            resolveWith(call, true);
            return;
        }
        requestPermissionForAlias(ALIAS, call, "onPermissionResult");
    }

    @PermissionCallback
    private void onPermissionResult(PluginCall call) {
        resolveWith(call, getPermissionState(ALIAS) == PermissionState.GRANTED);
    }

    private void resolveWith(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }
}
