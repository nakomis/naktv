import os
import WebKit

private let logger = Logger(subsystem: "com.nakomis.naktv", category: "web")

/// Hosts the webOS build (`app/dist`, bundled as `www/`) in a WKWebView,
/// unmodified — the same job `MainActivity` does on Android. The web app
/// doesn't know which platform it is on.
///
/// What it needs that a bare WKWebView doesn't do:
///
///  1. Universal access from file URLs, so the file:// page can fetch
///     cthulhu's `/api/status`, OctoPrint and the now-playing server, none of
///     which send CORS headers. Apple has no public switch for it, so this
///     sets WebKit's private preferences by key — fine for a build installed
///     straight from Xcode, and the reason this could never go through App
///     Review.
///  2. Media that starts, and unmutes, without a tap: the feed autoplays
///     muted and unmutes once frames arrive (`CameraFeed.tsx`).
///  3. `window.close()`, which the page calls on Back, turned into something
///     native — see `onExit`.
final class NakTVWebController: NSObject {
    let webView: WKWebView

    /// Called when the page asks to close (Back, or Escape on a keyboard).
    var onExit: () -> Void = {}

    private var probeTimer: Timer?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.setValue(true, forKey: "allowUniversalAccessFromFileURLs")
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        configuration.mediaTypesRequiringUserActionForPlayback = []
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        #endif

        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: Self.bridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        #if os(macOS)
        // The TV hides the pointer (the Magic Remote's is drawn by webOS);
        // on a Mac it is the only way to reach the tab strip.
        controller.addUserScript(WKUserScript(
            source: "document.head.insertAdjacentHTML('beforeend', '<style>body { cursor: auto !important; }</style>');",
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        #endif
        configuration.userContentController = controller

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        // A weak hop, because the content controller retains its handlers.
        controller.add(WeakMessageHandler(self), name: "naktv")
        webView.navigationDelegate = self
        webView.isInspectable = true // Safari ▸ Develop, for this device

        #if os(iOS)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #else
        webView.setValue(false, forKey: "drawsBackground")
        #endif
    }

    func load() {
        guard let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") else {
            logger.fault("www/index.html is missing from the bundle — build with scripts/install-apple.sh")
            webView.loadHTMLString(Self.missingBuildPage, baseURL: nil)
            return
        }
        webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }

    /// Runs inside the page before any of its own scripts.
    ///
    /// - `window.close()` posts to the native side instead of doing nothing,
    ///   which is all it does for a window the page didn't open itself.
    /// - Media stays muted. The feed carries the TV's soundtrack, which isn't
    ///   wanted on a phone or a Mac, but the page unmutes the `<video>` once
    ///   frames arrive (`CameraFeed.tsx`), so the setter is pinned to `true`.
    ///   Muted, it also leaves the phone's own music playing.
    /// - The console, uncaught errors and rejections go to the unified log
    ///   (subsystem `com.nakomis.naktv`), so `[naktv/mse]` lines can be read
    ///   in Console.app or `log stream` without attaching Safari.
    private static let bridgeScript = """
    (function () {
      var post = function (message) {
        try { window.webkit.messageHandlers.naktv.postMessage(message); } catch (e) {}
      };
      window.close = function () { post({ type: 'exit' }); };
      var muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
      Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
        configurable: true,
        get: muted.get,
        set: function () { muted.set.call(this, true); }
      });
      ['log', 'info', 'warn', 'error'].forEach(function (level) {
        var original = console[level];
        console[level] = function () {
          var text = Array.prototype.map.call(arguments, function (arg) {
            if (typeof arg === 'string') return arg;
            try { return JSON.stringify(arg); } catch (e) { return String(arg); }
          }).join(' ');
          post({ type: 'console', level: level, text: text });
          return original.apply(console, arguments);
        };
      });
      window.addEventListener('error', function (event) {
        post({ type: 'console', level: 'error', text: 'uncaught: ' + event.message + ' at ' + event.filename + ':' + event.lineno });
      });
      window.addEventListener('unhandledrejection', function (event) {
        post({ type: 'console', level: 'error', text: 'unhandled rejection: ' + String(event.reason) });
      });
    })();
    """

    private static let missingBuildPage = """
    <body style="background:#000;color:#ccc;font:16px -apple-system;padding:2em">
    <p>NakTV's web build isn't in this app bundle.</p>
    <p>Build it with <code>scripts/install-apple.sh</code>, which copies <code>app/dist</code> into <code>apple/www</code> first.</p>
    </body>
    """

    // MARK: - Probe

    /// With `-NakTVProbe` on the command line, logs the player's state every
    /// few seconds: a way to check a build on a simulator, or on a Mac, from
    /// the log alone.
    private func startProbeIfAsked() {
        guard probeTimer == nil, ProcessInfo.processInfo.arguments.contains("-NakTVProbe") else { return }
        probeTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.webView.evaluateJavaScript(Self.probeScript) { result, error in
                if let error {
                    logger.error("probe failed: \(error.localizedDescription, privacy: .public)")
                } else {
                    logger.notice("probe: \(String(describing: result ?? "nil"), privacy: .public)")
                }
            }
        }
    }

    /// With `-NakTVTab <title>`, opens on that tab rather than the last one
    /// shown — for driving a build from a script, which can't press keys.
    private func selectTabIfAsked() {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flag = arguments.firstIndex(of: "-NakTVTab"), flag + 1 < arguments.count,
              let title = String(data: try! JSONEncoder().encode(arguments[flag + 1]), encoding: .utf8)
        else { return }
        webView.evaluateJavaScript("""
        Array.prototype.forEach.call(document.querySelectorAll('[role=tab]'), function (tab) {
          if (tab.textContent === \(title)) tab.click();
        });
        """)
    }

    private static let probeScript = """
    (function () {
      var video = document.querySelector('video');
      var img = document.querySelector('img');
      var tab = document.querySelector('[role=tab][aria-selected=true]');
      var log = window.__naktvMseLog || [];
      return JSON.stringify({
        tab: tab && tab.textContent,
        MediaSource: typeof MediaSource,
        ManagedMediaSource: typeof ManagedMediaSource,
        video: video && {
          readyState: video.readyState, paused: video.paused, muted: video.muted,
          currentTime: Math.round(video.currentTime * 10) / 10,
          size: video.videoWidth + 'x' + video.videoHeight
        },
        img: img && { src: img.src.slice(0, 60), size: img.naturalWidth + 'x' + img.naturalHeight },
        mse: log.slice(-3).map(function (e) { return e.event; }),
        text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160)
      });
    })();
    """
}

// MARK: - WKScriptMessageHandler

extension NakTVWebController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "exit":
            onExit()
        case "console":
            let text = body["text"] as? String ?? ""
            switch body["level"] as? String {
            case "error": logger.error("\(text, privacy: .public)")
            case "warn": logger.warning("\(text, privacy: .public)")
            default: logger.info("\(text, privacy: .public)")
            }
        default:
            break
        }
    }
}

// MARK: - WKNavigationDelegate

extension NakTVWebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        logger.notice("loaded \(webView.url?.lastPathComponent ?? "?", privacy: .public)")
        selectTabIfAsked()
        startProbeIfAsked()
    }

    /// iOS kills a backgrounded page's content process under memory pressure,
    /// which leaves a blank view behind; start again rather than show that.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        logger.error("web content process terminated; reloading")
        load()
    }
}

/// Holds the controller weakly, so the content controller doesn't keep it alive.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
