import Foundation
import Capacitor

/// Free and total bytes on the device volume, for Settings > Device storage.
/// iOS keeps every download in the app's Documents folder, so the location
/// argument is ignored.
@objc(DeviceStoragePlugin)
public class DeviceStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceStoragePlugin"
    public let jsName = "DeviceStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "space", returnType: CAPPluginReturnPromise)
    ]

    @objc func space(_ call: CAPPluginCall) {
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            call.reject("Storage is not available.")
            return
        }
        do {
            let values = try dir.resourceValues(forKeys: [
                .volumeAvailableCapacityForImportantUsageKey,
                .volumeTotalCapacityKey
            ])
            guard let free = values.volumeAvailableCapacityForImportantUsage else {
                call.reject("Could not read storage space.")
                return
            }
            var out: [String: Any] = ["freeBytes": free]
            if let total = values.volumeTotalCapacity { out["totalBytes"] = total }
            call.resolve(out)
        } catch {
            call.reject("Could not read storage space.", nil, error)
        }
    }
}

/// Bridge view controller that registers the app-local plugins.
class AppBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeviceStoragePlugin())
    }
}
