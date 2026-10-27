package app.openrecord;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotificationPermissionPlugin.class);
        registerPlugin(DeviceStoragePlugin.class);
        registerPlugin(BackgroundWorkPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
