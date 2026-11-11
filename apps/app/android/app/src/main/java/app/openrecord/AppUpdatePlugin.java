package app.openrecord;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Downloads a signed release APK from GitHub Releases into the app cache and
 * hands it to the system installer (sideloaded Android builds only; the Play
 * Store build never uses this). Updates install over the existing app because
 * every release is signed with the same keystore.
 *
 * Only HTTPS to GitHub hosts is accepted, including each redirect hop. The
 * downloaded file stays in the app-private cache and is exposed to the
 * installer only through the FileProvider.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private static final Set<String> ALLOWED_HOSTS = Set.of(
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com"
    );
    /** The first URL must be a release asset of this repository (redirect hops are host-checked only). */
    private static final String RELEASE_HOST = "github.com";
    private static final String RELEASE_PATH_PREFIX = "/ahnafone/open-record/releases/download/";
    private static final int MAX_REDIRECTS = 5;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final long PROGRESS_INTERVAL_MS = 150;
    private static final String UPDATE_DIR = "updates";
    /** Final name; only a fully downloaded and verified file is ever renamed to it. */
    private static final String UPDATE_FILE = "open-record-update.apk";
    /** Partial download; never handed to the installer. */
    private static final String PART_FILE = "open-record-update.apk.part";
    private static final String GENERIC_FAILURE = "Update download failed. Check your connection and try again.";
    private static final String NO_CHECKSUM_MESSAGE = "No checksum published for this release; cannot verify the update.";
    /** Largest checksum file accepted (a SHA256SUMS file lists a handful of lines). */
    private static final int CHECKSUM_MAX_BYTES = 64 * 1024;
    /** "<hex>  <name>" or "<hex> *<name>" (sha256sum output). */
    private static final Pattern CHECKSUM_LINE = Pattern.compile("([0-9a-fA-F]{64})\\s+\\*?(.+)");
    private static final Pattern LONE_SHA256 = Pattern.compile("[0-9a-fA-F]{64}");

    /** Incremented by every download call; an older in-flight download aborts when it sees a newer value. */
    private final AtomicInteger downloadGeneration = new AtomicInteger();

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject out = new JSObject();
            out.put("version", info.versionName == null ? "" : info.versionName);
            call.resolve(out);
        } catch (PackageManager.NameNotFoundException e) {
            call.reject("Could not read the installed version.", e);
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        String rawUrl = call.getString("url");
        String rawChecksumUrl = call.getString("checksumUrl");
        String expectedSha;
        URL start;
        URL checksumStart = null;
        try {
            if (rawUrl == null || rawUrl.isEmpty()) {
                throw new UpdateException("No update download URL was given.");
            }
            start = validateInitial(rawUrl);
            expectedSha = normalizeSha256(call.getString("sha256"));
            if (rawChecksumUrl != null && !rawChecksumUrl.isEmpty()) {
                checksumStart = validateInitial(rawChecksumUrl);
            }
        } catch (UpdateException e) {
            call.reject(e.getMessage());
            return;
        }

        final URL checksumSource = checksumStart;
        final int generation = downloadGeneration.incrementAndGet();
        new Thread(
            () -> runDownload(call, start, expectedSha, checksumSource, generation),
            "app-update-download"
        ).start();
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject out = new JSObject();
        out.put("granted", granted);
        call.resolve(out);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Before Android 8 the "install unknown apps" switch is global and not per app.
            call.resolve();
            return;
        }
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("Could not open the install permission settings.", e);
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        File file = updateFile();
        if (!file.isFile()) {
            call.reject("Download the update before installing it.");
            return;
        }
        Uri uri;
        try {
            uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );
        } catch (IllegalArgumentException e) {
            call.reject("Could not prepare the update for installation.", e);
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app is available to install the update.", e);
        }
    }

    private void runDownload(PluginCall call, URL start, String expectedSha, URL checksumUrl, int generation) {
        File part = partFile();
        File file = updateFile();
        HttpURLConnection conn = null;
        try {
            // Resolved before any APK bytes are fetched: no verifiable hash, no download.
            String expected = expectedSha != null ? expectedSha : fetchExpectedSha(start, checksumUrl);
            // A newer request may have arrived while the checksum was fetched; do not touch the files it owns.
            if (generation != downloadGeneration.get()) {
                throw new UpdateException("The update download was replaced by a newer request.");
            }
            deleteOldUpdates();
            conn = openWithRedirects(start);
            // A newer request may have arrived while the redirects were followed: abort before writing.
            // The finally block disconnects conn; failDownload leaves the newer request's part file alone.
            if (generation != downloadGeneration.get()) {
                throw new UpdateException("The update download was replaced by a newer request.");
            }
            long total = conn.getContentLengthLong();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long done = 0;
            long lastEmit = 0;
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (generation != downloadGeneration.get()) {
                        throw new UpdateException("The update download was replaced by a newer request.");
                    }
                    out.write(buf, 0, n);
                    digest.update(buf, 0, n);
                    done += n;
                    long now = System.currentTimeMillis();
                    if (total > 0 && now - lastEmit >= PROGRESS_INTERVAL_MS) {
                        lastEmit = now;
                        emitProgress(Math.min(1.0, (double) done / total));
                    }
                }
            }
            if (!toHex(digest.digest()).equals(expected)) {
                throw new UpdateException("The downloaded update failed its checksum. Try again.");
            }
            if (generation != downloadGeneration.get()) {
                throw new UpdateException("The update download was replaced by a newer request.");
            }
            // Verified: promote the partial file to the only name install() reads.
            if (file.exists() && !file.delete()) {
                throw new UpdateException("Could not replace the previous update file.");
            }
            if (!part.renameTo(file)) {
                throw new UpdateException("Could not save the update.");
            }
            emitProgress(1.0);
            JSObject out = new JSObject();
            out.put("path", file.getAbsolutePath());
            call.resolve(out);
        } catch (UpdateException e) {
            failDownload(call, e.getMessage(), generation, part);
        } catch (Exception e) {
            failDownload(call, GENERIC_FAILURE, generation, part);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /**
     * The SHA-256 the APK must match. Used when the release gives no digest
     * directly: reads the checksum asset and picks this APK's line (or a lone
     * hash). Throws when no usable hash exists, so the caller never downloads.
     */
    private static String fetchExpectedSha(URL apk, URL checksumUrl) throws UpdateException, IOException {
        if (checksumUrl == null) {
            throw new UpdateException(NO_CHECKSUM_MESSAGE);
        }
        String text;
        try {
            text = readSmallText(checksumUrl);
        } catch (UpdateException e) {
            throw new UpdateException(NO_CHECKSUM_MESSAGE);
        }

        String apkName = fileName(apk);
        String named = null;
        String lone = null;
        int loneCount = 0;
        for (String line : text.split("\\r?\\n")) {
            String trimmed = line.trim();
            Matcher entry = CHECKSUM_LINE.matcher(trimmed);
            if (entry.matches()) {
                if (apkName.equals(entry.group(2).trim())) {
                    named = entry.group(1).toLowerCase(Locale.ROOT);
                }
            } else if (LONE_SHA256.matcher(trimmed).matches()) {
                lone = trimmed.toLowerCase(Locale.ROOT);
                loneCount++;
            }
        }

        String hex = named != null ? named : (loneCount == 1 ? lone : null);
        if (hex == null) {
            throw new UpdateException(NO_CHECKSUM_MESSAGE);
        }
        return hex;
    }

    /** Reads a small text file from the same allowed release hosts; never more than CHECKSUM_MAX_BYTES. */
    private static String readSmallText(URL url) throws UpdateException, IOException {
        HttpURLConnection conn = openWithRedirects(url);
        try (InputStream in = conn.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                if (out.size() + n > CHECKSUM_MAX_BYTES) {
                    throw new UpdateException("The update checksum file is too large.");
                }
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            conn.disconnect();
        }
    }

    /** The last path segment of a URL (the release asset's file name). */
    private static String fileName(URL url) {
        String path = url.getPath();
        return path.substring(path.lastIndexOf('/') + 1);
    }

    private void failDownload(PluginCall call, String message, int generation, File part) {
        // A replaced download must not delete the partial file the newer request is writing.
        if (generation == downloadGeneration.get() && part.exists()) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
        }
        call.reject(message);
    }

    /** Follows redirects by hand so every hop is re-validated. */
    private static HttpURLConnection openWithRedirects(URL start) throws IOException, UpdateException {
        URL url = start;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("Accept", "application/octet-stream");
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null) {
                    throw new UpdateException("The update download redirected without a destination.");
                }
                try {
                    url = validate(new URL(url, location).toString());
                } catch (MalformedURLException e) {
                    throw new UpdateException("The update download redirected to an invalid address.");
                }
                continue;
            }
            if (code != HttpURLConnection.HTTP_OK) {
                conn.disconnect();
                throw new UpdateException("Update download failed (HTTP " + code + ").");
            }
            return conn;
        }
        throw new UpdateException("The update download redirected too many times.");
    }

    /** The URL the app asks for: a release asset of this repository, on top of the host rules. */
    private static URL validateInitial(String raw) throws UpdateException {
        URL url = validate(raw);
        String host = url.getHost().toLowerCase(Locale.ROOT);
        if (!RELEASE_HOST.equals(host)) {
            throw new UpdateException("Update downloads must come from this app's GitHub releases.");
        }
        // Checked on the decoded path (URI.getPath() turns %2e into '.', so encoded dot
        // segments are seen too). URI.normalize() is not used: it does not decode escapes.
        String rawPath = url.getPath();
        String rawLower = rawPath.toLowerCase(Locale.ROOT);
        String decoded;
        try {
            decoded = url.toURI().getPath();
        } catch (URISyntaxException e) {
            throw new UpdateException("Invalid update download URL.");
        }
        if (decoded == null) {
            throw new UpdateException("Update downloads must come from this app's GitHub releases.");
        }
        // Encoded separators could smuggle a path boundary past the segment checks.
        if (rawLower.contains("%2f") || rawLower.contains("%5c")) {
            throw new UpdateException("Update downloads must come from this app's GitHub releases.");
        }
        if (decoded.contains("\\") || decoded.contains("//")) {
            throw new UpdateException("Update downloads must come from this app's GitHub releases.");
        }
        for (String segment : decoded.split("/")) {
            if (segment.equals(".") || segment.equals("..")) {
                throw new UpdateException("Update downloads must come from this app's GitHub releases.");
            }
        }
        if (!decoded.toLowerCase(Locale.ROOT).startsWith(RELEASE_PATH_PREFIX)) {
            throw new UpdateException("Update downloads must come from this app's GitHub releases.");
        }
        return url;
    }

    private static URL validate(String raw) throws UpdateException {
        URL url;
        try {
            url = new URL(raw);
        } catch (MalformedURLException e) {
            throw new UpdateException("Invalid update download URL.");
        }
        if (!"https".equalsIgnoreCase(url.getProtocol())) {
            throw new UpdateException("Update downloads must use HTTPS.");
        }
        if (url.getPort() != -1 && url.getPort() != 443) {
            throw new UpdateException("Update download uses an unexpected port.");
        }
        String host = url.getHost().toLowerCase(Locale.ROOT);
        if (!ALLOWED_HOSTS.contains(host)) {
            throw new UpdateException("Update downloads must come from GitHub.");
        }
        return url;
    }

    /** Accepts plain hex or the "sha256:<hex>" form; returns lowercase hex or null when absent. */
    private static String normalizeSha256(String raw) throws UpdateException {
        if (raw == null || raw.trim().isEmpty()) {
            return null;
        }
        String hex = raw.trim().toLowerCase(Locale.ROOT);
        if (hex.startsWith("sha256:")) {
            hex = hex.substring("sha256:".length());
        }
        if (!hex.matches("[0-9a-f]{64}")) {
            throw new UpdateException("The update checksum is invalid.");
        }
        return hex;
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.ROOT, "%02x", b));
        }
        return sb.toString();
    }

    private File updateDir() {
        return new File(getContext().getCacheDir(), UPDATE_DIR);
    }

    private File updateFile() {
        return new File(updateDir(), UPDATE_FILE);
    }

    private File partFile() {
        return new File(updateDir(), PART_FILE);
    }

    private void deleteOldUpdates() {
        File dir = updateDir();
        File[] old = dir.listFiles();
        if (old != null) {
            for (File f : old) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
    }

    private void emitProgress(double fraction) {
        if (getActivity() == null) {
            return;
        }
        getActivity().runOnUiThread(() -> {
            JSObject data = new JSObject();
            data.put("fraction", fraction);
            notifyListeners("progress", data);
        });
    }

    /** Failure with a message that is safe to show the user. */
    private static class UpdateException extends Exception {
        UpdateException(String message) {
            super(message);
        }
    }
}
