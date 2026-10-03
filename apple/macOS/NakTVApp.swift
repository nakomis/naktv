import SwiftUI
import WebKit

@main
struct NakTVApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate

    var body: some Scene {
        WindowGroup {
            NakTVView()
                .background(Color.black)
                .frame(minWidth: 480, minHeight: 270)
        }
        .defaultSize(width: 1280, height: 720)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var activity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The webOS build vetoes the TV's screen saver; this is the Mac's
        // equivalent, for as long as NakTV is open.
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.idleDisplaySleepDisabled, .userInitiated],
            reason: "Showing a live camera feed"
        )
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

struct NakTVView: NSViewRepresentable {
    func makeCoordinator() -> NakTVWebController {
        NakTVWebController()
    }

    func makeNSView(context: Context) -> WKWebView {
        let webView = context.coordinator.webView
        // Escape is Back, and Back closes the app on the TVs. On a Mac, Escape
        // in full screen means "leave full screen", so honour that first;
        // otherwise close the window, which quits (see the delegate).
        context.coordinator.onExit = { [weak webView] in
            guard let window = webView?.window else { return }
            if window.styleMask.contains(.fullScreen) {
                window.toggleFullScreen(nil)
            } else {
                window.performClose(nil)
            }
        }
        context.coordinator.load()
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}
}
