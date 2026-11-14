package app.openrecord;

import android.os.Bundle;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotificationPermissionPlugin.class);
        registerPlugin(DeviceStoragePlugin.class);
        registerPlugin(BackgroundWorkPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(SystemVolumePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (handleVolumeKey(keyCode, true)) {
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (handleVolumeKey(keyCode, false)) {
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    /** True when SystemVolume's key intercept consumed the volume key. */
    private boolean handleVolumeKey(int keyCode, boolean down) {
        if (getBridge() == null) {
            return false;
        }
        PluginHandle handle = getBridge().getPlugin("SystemVolume");
        if (handle == null) {
            return false;
        }
        return ((SystemVolumePlugin) handle.getInstance()).onVolumeKey(keyCode, down);
    }
}
