import AppKit
import SwiftUI

@main
struct LoopdropNativeApp: App {
    @NSApplicationDelegateAdaptor(LoopdropAppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            SettingsView(preferences: appDelegate.model.preferences)
        }
    }
}

@MainActor
final class LoopdropAppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    let model = LoopdropViewModel(converter: NativeGIFConverter())

    private let popover = NSPopover()
    private var statusItem: NSStatusItem?
    private var escapeMonitor: Any?
    private var openPanel: NSOpenPanel?
    private var fallbackSettingsController: LoopdropSettingsWindowController?
    private var isWaitingToTerminate = false
    private lazy var updateCoordinator = NativeUpdateCoordinator(
        currentVersion: Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "",
        isConversionActive: { [weak self] in self?.model.isConverting ?? false }
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        configurePopover()
        configureStatusItem()
        acceptCommandLineVideoIfPresent()
        updateCoordinator.start()

        // Showing the prototype on launch makes it discoverable and allows
        // deterministic visual QA. `--hidden` opts into traditional tray-only launch.
        if !ProcessInfo.processInfo.arguments.contains("--hidden") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                self?.showPopover()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        updateCoordinator.stop()
        removeEscapeMonitor()
        model.setPreviewVisible(false)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard model.isConverting else { return .terminateNow }
        guard !isWaitingToTerminate else { return .terminateLater }

        isWaitingToTerminate = true
        model.setPreviewVisible(false)
        Task { [weak self] in
            guard let self else {
                sender.reply(toApplicationShouldTerminate: true)
                return
            }
            await self.model.cancelConversionAndWait()
            self.isWaitingToTerminate = false
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private func configurePopover() {
        popover.contentSize = NSSize(width: 410, height: 176)
        popover.behavior = .applicationDefined
        popover.animates = true
        popover.delegate = self
        popover.contentViewController = NSHostingController(
            rootView: CompactConverterView(
                model: model,
                chooseVideo: { [weak self] in self?.chooseVideo() },
                openSettings: { [weak self] in self?.showSettings() },
                closePopover: { [weak self] in self?.closePopover() }
            )
        )
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item

        guard let button = item.button else { return }
        let image = NSImage(
            systemSymbolName: "film.stack",
            accessibilityDescription: "Loopdrop"
        )
        image?.isTemplate = true
        button.image = image
        button.imagePosition = .imageOnly
        button.toolTip = "Loopdrop"
        button.target = self
        button.action = #selector(statusItemPressed(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.setAccessibilityLabel("Loopdrop mini converter")
        button.setAccessibilityHelp("Opens Loopdrop. Right-click for Settings or Quit.")
    }

    @objc private func statusItemPressed(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showContextMenu(from: sender)
        } else if popover.isShown {
            closePopover()
        } else {
            showPopover()
        }
    }

    private func showPopover() {
        guard !popover.isShown, let button = statusItem?.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        model.setPreviewVisible(true)
        NSApp.activate(ignoringOtherApps: true)
        popover.contentViewController?.view.window?.makeKey()
        installEscapeMonitor()
    }

    private func closePopover() {
        guard popover.isShown else { return }
        model.setPreviewVisible(false)
        popover.performClose(nil)
        removeEscapeMonitor()
    }

    private func installEscapeMonitor() {
        guard escapeMonitor == nil else { return }
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53, self?.popover.isShown == true else { return event }
            // Let Escape dismiss an attached file panel before it can dismiss Loopdrop.
            guard self?.openPanel == nil else { return event }
            self?.closePopover()
            return nil
        }
    }

    private func removeEscapeMonitor() {
        guard let escapeMonitor else { return }
        NSEvent.removeMonitor(escapeMonitor)
        self.escapeMonitor = nil
    }

    func popoverDidClose(_ notification: Notification) {
        model.setPreviewVisible(false)
        removeEscapeMonitor()
    }

    private func chooseVideo() {
        if let openPanel {
            NSApp.activate(ignoringOtherApps: true)
            openPanel.makeKeyAndOrderFront(nil)
            return
        }

        let panel = NSOpenPanel()
        panel.title = "Choose a Video"
        panel.message = "Choose a video that macOS can play. The original file is never modified."
        panel.prompt = "Choose Video"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.resolvesAliases = true
        openPanel = panel

        let completion: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self else { return }
            defer { self.openPanel = nil }
            guard response == .OK, let url = panel.url else { return }
            self.model.acceptInput(url)
        }

        if let parentWindow = popover.contentViewController?.view.window {
            panel.beginSheetModal(for: parentWindow, completionHandler: completion)
        } else {
            panel.begin(completionHandler: completion)
        }
    }

    private func showSettings() {
        NSApp.activate(ignoringOtherApps: true)
        let didOpenSettings = NSApp.sendAction(
            Selector(("showSettingsWindow:")),
            to: nil,
            from: nil
        ) || NSApp.sendAction(
            Selector(("showPreferencesWindow:")),
            to: nil,
            from: nil
        )

        guard !didOpenSettings else { return }
        if fallbackSettingsController == nil {
            fallbackSettingsController = LoopdropSettingsWindowController(
                preferences: model.preferences
            )
        }
        fallbackSettingsController?.showWindow(nil)
        fallbackSettingsController?.window?.makeKeyAndOrderFront(nil)
    }

    private func showContextMenu(from button: NSStatusBarButton) {
        let menu = NSMenu(title: "Loopdrop")
        menu.addItem(
            withTitle: "Check for Updates…",
            action: #selector(checkForUpdatesFromMenu),
            keyEquivalent: ""
        )
        menu.addItem(.separator())
        menu.addItem(withTitle: "Settings…", action: #selector(openSettingsFromMenu), keyEquivalent: ",")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Loopdrop", action: #selector(quit), keyEquivalent: "q")
        menu.items.forEach { $0.target = self }
        menu.popUp(
            positioning: nil,
            at: NSPoint(x: button.bounds.minX, y: button.bounds.minY - 4),
            in: button
        )
    }

    @objc private func openSettingsFromMenu() {
        showSettings()
    }

    @objc private func checkForUpdatesFromMenu() {
        updateCoordinator.checkManually()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func acceptCommandLineVideoIfPresent() {
        guard let path = ProcessInfo.processInfo.arguments.dropFirst().first(where: {
            !$0.hasPrefix("-")
        }) else { return }
        model.acceptInput(URL(fileURLWithPath: path))
    }
}

@MainActor
private final class LoopdropSettingsWindowController: NSWindowController {
    init(preferences: LoopdropPreferences) {
        let content = NSHostingController(rootView: SettingsView(preferences: preferences))
        let window = NSWindow(contentViewController: content)
        window.title = "Loopdrop Settings"
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }
}
