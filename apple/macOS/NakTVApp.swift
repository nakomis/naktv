import AppKit
import WebKit

/// Plain AppKit rather than a SwiftUI `WindowGroup`: SwiftUI's scene
/// restoration sometimes relaunched the app with no window at all, and a
/// camera viewer wants exactly one window, opened every time. One window is
/// also one go2rtc consumer, like the TV.
@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private lazy var controller = NakTVWebController()
    private var window: NSWindow!
    private var activity: NSObjectProtocol?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = Self.makeMainMenu()

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "NakTV"
        window.backgroundColor = .black
        window.contentMinSize = NSSize(width: 480, height: 270)
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("NakTV")
        if !window.setFrameUsingName("NakTV") { window.center() }
        window.contentView = controller.webView

        // Escape is Back, and Back closes the app on the TVs. On a Mac, Escape
        // in full screen means "leave full screen", so honour that first;
        // otherwise close the window, which quits (see below).
        controller.onExit = { [weak window] in
            guard let window else { return }
            if window.styleMask.contains(.fullScreen) {
                window.toggleFullScreen(nil)
            } else {
                window.performClose(nil)
            }
        }
        controller.load()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

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

    /// Without a storyboard there is no menu bar unless we build one: Quit,
    /// Hide, full screen and the window commands.
    private static func makeMainMenu() -> NSMenu {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About NakTV",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide NakTV", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others",
                                         action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit NakTV", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu(appMenu))

        let viewMenu = NSMenu(title: "View")
        let fullScreen = viewMenu.addItem(withTitle: "Enter Full Screen",
                                          action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        main.addItem(submenu(viewMenu))

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimise", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        main.addItem(submenu(windowMenu))
        NSApp.windowsMenu = windowMenu

        return main
    }

    private static func submenu(_ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem()
        item.submenu = menu
        return item
    }
}
