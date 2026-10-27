package app.openrecord;

import android.os.StatFs;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * Free and total bytes on the volume behind a download location, for
 * Settings > Device storage. "external" is the app-specific external files
 * dir (Capacitor Directory.External); anything else is app data
 * (Directory.Data). No permissions needed.
 */
@CapacitorPlugin(name = "DeviceStorage")
public class DeviceStoragePlugin extends Plugin {

    @PluginMethod
    public void space(PluginCall call) {
        String location = call.getString("location", "data");
        File dir = "external".equals(location)
            ? getContext().getExternalFilesDir(null)
            : getContext().getFilesDir();
        if (dir == null) {
            call.reject("Storage is not available.");
            return;
        }
        try {
            StatFs stat = new StatFs(dir.getAbsolutePath());
            JSObject out = new JSObject();
            out.put("freeBytes", stat.getAvailableBytes());
            out.put("totalBytes", stat.getTotalBytes());
            call.resolve(out);
        } catch (IllegalArgumentException e) {
            call.reject("Could not read storage space.", e);
        }
    }
}
