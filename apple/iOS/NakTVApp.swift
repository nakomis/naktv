import SwiftUI
import WebKit

@main
struct NakTVApp: App {
    var body: some Scene {
        WindowGroup {
            ZStack {
                Color.black.ignoresSafeArea()
                // Inside the safe area, so the tab strip never sits under the
                // Dynamic Island or the home indicator; the bars either side
                // are black, which an OLED shows as nothing.
                NakTVView()
            }
            .statusBarHidden()
            .persistentSystemOverlays(.hidden)
            .onAppear {
                // The webOS build vetoes the TV's screen saver; this is the
                // phone's equivalent, for as long as NakTV is in front.
                UIApplication.shared.isIdleTimerDisabled = true
            }
        }
    }
}

struct NakTVView: UIViewRepresentable {
    func makeCoordinator() -> NakTVWebController {
        let controller = NakTVWebController()
        // Back (Escape on an iPad keyboard) closes the app on the TVs. An iOS
        // app doesn't quit itself, so there is nothing to do.
        controller.onExit = {}
        return controller
    }

    func makeUIView(context: Context) -> WKWebView {
        context.coordinator.load()
        return context.coordinator.webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
