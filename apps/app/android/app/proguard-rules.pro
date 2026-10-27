# R8 keep rules for the release build (minifyEnabled true).
#
# Capacitor instantiates plugins reflectively from capacitor.plugins.json and
# dispatches JS calls to @PluginMethod methods by name, so plugin classes and
# their methods must survive shrinking and obfuscation.

-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,SourceFile,LineNumberTable

# Capacitor runtime and bridge.
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep public class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
}
# WebView JS interfaces.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# The app's own plugins (BackgroundWork, NotificationPermission, DeviceStorage),
# MainActivity and the DownloadService foreground service.
-keep class app.openrecord.** { *; }

# Official Capacitor plugins (@capacitor/app, filesystem, network, preferences).
-keep class com.capacitorjs.plugins.** { *; }

# capacitor-plugin-playlist (native playback, media3 session, handoff workers).
-keep class org.dwbn.plugins.playlist.** { *; }

# @capacitor-community/sqlite and its SQLCipher JNI bindings.
-keep class com.getcapacitor.community.database.sqlite.** { *; }
-keep class net.zetetic.** { *; }
-dontwarn net.zetetic.**

# @capacitor-mlkit/barcode-scanning.
-keep class io.capawesome.capacitorjs.plugins.mlkit.barcodescanning.** { *; }

# @capawesome/capacitor-file-picker.
-keep class io.capawesome.capacitorjs.plugins.filepicker.** { *; }

# Cordova compatibility layer (capacitor-cordova-android-plugins).
-keep public class * extends org.apache.cordova.* {
    public <methods>;
    public <fields>;
}
-dontwarn org.apache.cordova.**
