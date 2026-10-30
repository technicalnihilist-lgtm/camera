package app.liquidglass.camera;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {

    private static final int REQ_WEB = 101;
    private static final int REQ_FILE = 102;

    private WebView web;
    private AssetServer server;
    private PermissionRequest pendingWeb;
    private ValueCallback<Uri[]> pendingFile;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    public void run() {
                        List<String> need = new ArrayList<String>();
                        for (String r : request.getResources()) {
                            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) need.add(Manifest.permission.CAMERA);
                            else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) need.add(Manifest.permission.RECORD_AUDIO);
                        }
                        pendingWeb = request;
                        List<String> missing = new ArrayList<String>();
                        for (String p : need) {
                            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
                        }
                        if (missing.isEmpty()) {
                            try { request.grant(request.getResources()); } catch (Exception ignored) {}
                            pendingWeb = null;
                        } else {
                            requestPermissions(missing.toArray(new String[0]), REQ_WEB);
                        }
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pendingFile != null) pendingFile.onReceiveValue(null);
                pendingFile = cb;
                String type = "*/*";
                String[] acc = params.getAcceptTypes();
                if (acc != null && acc.length > 0 && acc[0] != null && acc[0].length() > 0) type = acc[0];
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(type);
                try {
                    startActivityForResult(Intent.createChooser(i, "Choose"), REQ_FILE);
                } catch (Exception e) {
                    pendingFile = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Saver(this), "AndroidCam");

        server = new AssetServer(getApplicationContext());
        server.start();
        web.loadUrl("http://127.0.0.1:" + server.port() + "/index.html");
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == REQ_WEB && pendingWeb != null) {
            boolean ok = true;
            for (int r : res) if (r != PackageManager.PERMISSION_GRANTED) ok = false;
            try {
                if (ok) pendingWeb.grant(pendingWeb.getResources());
                else pendingWeb.deny();
            } catch (Exception ignored) {}
            pendingWeb = null;
            if (!ok) Toast.makeText(this, "Camera permission is needed to use this app", Toast.LENGTH_LONG).show();
        }
        super.onRequestPermissionsResult(req, perms, res);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            if (pendingFile == null) return;
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    out = new Uri[]{data.getData()};
                }
            }
            pendingFile.onReceiveValue(out);
            pendingFile = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /* ---------------- gallery saving, driven from the page ---------------- */

    public static class Saver {
        private final Context ctx;
        private final Map<Integer, Job> jobs = new HashMap<Integer, Job>();
        private int next = 1;

        static class Job {
            File tmp;
            OutputStream out;
            String mime;
            String name;
        }

        Saver(Context c) { ctx = c; }

        @JavascriptInterface
        public int open(String mime, String name) {
            try {
                Job j = new Job();
                j.mime = (mime == null || mime.length() == 0) ? "application/octet-stream" : mime;
                j.name = safeName(name);
                j.tmp = File.createTempFile("lens", ".tmp", ctx.getCacheDir());
                j.out = new FileOutputStream(j.tmp);
                int id = next++;
                jobs.put(Integer.valueOf(id), j);
                return id;
            } catch (Exception e) {
                return 0;
            }
        }

        @JavascriptInterface
        public String write(int id, String b64) {
            Job j = jobs.get(Integer.valueOf(id));
            if (j == null) return "nojob";
            try {
                byte[] d = Base64.decode(b64, Base64.DEFAULT);
                j.out.write(d);
                return "ok";
            } catch (Exception e) {
                return "err";
            }
        }

        @JavascriptInterface
        public String close(int id) {
            Job j = jobs.remove(Integer.valueOf(id));
            if (j == null) return "nojob";
            try {
                j.out.flush();
                j.out.close();
                String where = publish(j);
                return where != null ? "ok:" + where : "err:publish";
            } catch (Exception e) {
                return "err:" + e.getMessage();
            } finally {
                try { j.tmp.delete(); } catch (Exception ignored) {}
            }
        }

        @JavascriptInterface
        public void abort(int id) {
            Job j = jobs.remove(Integer.valueOf(id));
            if (j == null) return;
            try { j.out.close(); } catch (Exception ignored) {}
            try { j.tmp.delete(); } catch (Exception ignored) {}
        }

        private static String safeName(String name) {
            String n = (name == null || name.length() == 0) ? "capture" : name;
            n = n.replace('/', '_').replace('\\', '_').replace(':', '-');
            return n.length() > 96 ? n.substring(n.length() - 96) : n;
        }

        private String publish(Job j) throws IOException {
            boolean video = j.mime.startsWith("video/");
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, j.name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, j.mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        (video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES) + "/Liquid Glass Camera");
                Uri uri = ctx.getContentResolver().insert(
                        video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return null;
                OutputStream o = ctx.getContentResolver().openOutputStream(uri);
                if (o == null) return null;
                copy(j.tmp, o);
                return uri.toString();
            }
            File dir = new File(Environment.getExternalStoragePublicDirectory(
                    video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES), "Liquid Glass Camera");
            if (!dir.exists() && !dir.mkdirs()) return null;
            File out = new File(dir, j.name);
            copy(j.tmp, new FileOutputStream(out));
            MediaScannerConnection.scanFile(ctx, new String[]{out.getAbsolutePath()}, new String[]{j.mime}, null);
            return out.getAbsolutePath();
        }

        private static void copy(File src, OutputStream os) throws IOException {
            InputStream in = new java.io.FileInputStream(src);
            try {
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                os.flush();
            } finally {
                try { in.close(); } catch (Exception ignored) {}
                try { os.close(); } catch (Exception ignored) {}
            }
        }
    }

    /* ---------------- tiny asset server on 127.0.0.1 (secure origin) ---------------- */

    public static class AssetServer {
        private final Context ctx;
        private ServerSocket ss;

        AssetServer(Context c) { ctx = c; }

        void start() {
            try {
                ss = new ServerSocket(0, 24, InetAddress.getByName("127.0.0.1"));
            } catch (IOException e) {
                ss = null;
                return;
            }
            Thread t = new Thread(new Runnable() {
                public void run() { acceptLoop(); }
            });
            t.setDaemon(true);
            t.start();
        }

        int port() { return ss == null ? 0 : ss.getLocalPort(); }

        void stop() {
            try { if (ss != null) ss.close(); } catch (IOException ignored) {}
        }

        private void acceptLoop() {
            while (true) {
                try {
                    final Socket s = ss.accept();
                    Thread h = new Thread(new Runnable() {
                        public void run() { serve(s); }
                    });
                    h.setDaemon(true);
                    h.start();
                } catch (IOException e) {
                    return;
                }
            }
        }

        private void serve(Socket s) {
            try {
                s.setSoTimeout(8000);
                InputStream in = s.getInputStream();
                StringBuilder head = new StringBuilder();
                int c;
                while ((c = in.read()) != -1) {
                    head.append((char) c);
                    int n = head.length();
                    if (n >= 4 && head.charAt(n - 1) == '\n' && head.charAt(n - 2) == '\r'
                            && head.charAt(n - 3) == '\n' && head.charAt(n - 4) == '\r') break;
                    if (n > 8192) break;
                }
                String line = head.toString();
                int sp = line.indexOf(' ');
                String path = "/";
                if (sp > 0) {
                    int sp2 = line.indexOf(' ', sp + 1);
                    if (sp2 > sp) path = line.substring(sp + 1, sp2);
                }
                int q = path.indexOf('?');
                if (q >= 0) path = path.substring(0, q);
                if (path.equals("/") || path.length() == 0) path = "/index.html";
                if (path.startsWith("/")) path = path.substring(1);
                if (path.contains("..")) { send(s, 404, "text/plain", "not found".getBytes("UTF-8")); return; }

                byte[] body;
                try {
                    InputStream a = ctx.getAssets().open(path);
                    java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = a.read(buf)) > 0) bo.write(buf, 0, n);
                    a.close();
                    body = bo.toByteArray();
                } catch (IOException e) {
                    send(s, 404, "text/plain", "not found".getBytes("UTF-8"));
                    return;
                }
                send(s, 200, mime(path), body);
            } catch (Exception e) {
                // ignore
            } finally {
                try { s.close(); } catch (IOException ignored) {}
            }
        }

        private static String mime(String p) {
            String l = p.toLowerCase();
            if (l.endsWith(".html") || l.endsWith(".htm")) return "text/html; charset=utf-8";
            if (l.endsWith(".js")) return "application/javascript";
            if (l.endsWith(".css")) return "text/css";
            if (l.endsWith(".png")) return "image/png";
            if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
            if (l.endsWith(".svg")) return "image/svg+xml";
            if (l.endsWith(".json")) return "application/json";
            return "application/octet-stream";
        }

        private static void send(Socket s, int code, String type, byte[] body) throws IOException {
            OutputStream o = s.getOutputStream();
            String head = "HTTP/1.1 " + code + (code == 200 ? " OK" : " Not Found") + "\r\n"
                    + "Content-Type: " + type + "\r\n"
                    + "Content-Length: " + body.length + "\r\n"
                    + "Cache-Control: no-store\r\n"
                    + "Connection: close\r\n\r\n";
            o.write(head.getBytes("UTF-8"));
            o.write(body);
            o.flush();
        }
    }
}
