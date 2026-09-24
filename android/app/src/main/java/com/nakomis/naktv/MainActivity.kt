package com.nakomis.naktv

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

private const val TAG = "NakTV"
private const val ASSET_URL = "file:///android_asset/www/index.html"

/**
 * Hosts the existing webOS build in a full-screen WebView, unmodified — the
 * web app doesn't know or care which platform it's running on, beyond the
 * `Keys.Escape` (27) code it already treats as Back (see `app/src/keys.ts`).
 *
 * Three things the web app needs that a bare WebView doesn't do by default:
 *
 *  1. `allowUniversalAccessFromFileURLs`, so the file:// page can fetch
 *     cthulhu's `http://…:9120/api/status`, which sends no CORS headers — the
 *     same reason the webOS build needs it (see `app/src/config.ts`).
 *  2. Android's hardware Back key has to reach the web app as a Back keydown,
 *     not close the Activity directly — `dispatchBackAsEscape` below.
 *  3. When the web app decides to exit (it always does, on Back — see
 *     `App.tsx`'s unconditional `onExit()`), it calls `window.close()`. A
 *     plain WebView's `window.close()` is a no-op except for popups opened by
 *     `window.open()`, which this page never does, so it's overridden after
 *     each load to call back into `NakTVAndroid.exit()` instead.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var pageLoaded = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this)
        setContentView(webView)

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowUniversalAccessFromFileURLs = true
            mediaPlaybackRequiresUserGesture = false
        }

        webView.addJavascriptInterface(ExitBridge(), "NakTVAndroid")

        webView.webChromeClient = object : WebChromeClient() {
            // Belt and braces alongside the window.close() override below: on
            // WebView builds where a top-level window.close() does trigger
            // this, honour it the same way.
            override fun onCloseWindow(window: WebView?) = finish()
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                pageLoaded = true
                // A bare WebView's window.close() only does anything for a
                // window opened via window.open(); this page never opens one,
                // so redirect it to the Activity finishing instead.
                view.evaluateJavascript(
                    "window.close = function() { NakTVAndroid.exit(); };",
                    null,
                )
            }
        }

        webView.loadUrl(ASSET_URL)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        // The TV is API 28; WindowInsetsController doesn't exist before API
        // 30, so this is the flag set it has to be — deprecated, not absent.
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            dispatchBackAsEscape()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /**
     * The web app's D-pad handling (`App.tsx`) always exits on Back, so there
     * is no "the app didn't consume it" case once the page has loaded — but
     * cover the moment before it has (a slow first load, or a WebView that
     * failed to attach the bridge) by finishing directly rather than doing
     * nothing when the remote's Back button is pressed.
     */
    private fun dispatchBackAsEscape() {
        if (!pageLoaded) {
            finish()
            return
        }
        // KeyboardEvent's constructor init dict doesn't actually set keyCode
        // in Chromium (it's read-only on the prototype), so it's overridden
        // per-instance with defineProperty — the same trick `keys.test.ts`
        // would need if it ever wanted to fabricate an event like this.
        val script = """
            (function() {
              var event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
              Object.defineProperty(event, 'keyCode', { get: function() { return 27; } });
              Object.defineProperty(event, 'which', { get: function() { return 27; } });
              document.dispatchEvent(event);
            })();
        """.trimIndent()
        webView.evaluateJavascript(script) { result ->
            Log.d(TAG, "dispatched Escape keydown for Back: $result")
        }
    }

    private inner class ExitBridge {
        @JavascriptInterface
        fun exit() {
            runOnUiThread { finish() }
        }
    }
}
