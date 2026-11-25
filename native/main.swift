import Cocoa
import WebKit
import Network

/// BooxDrop — native WebKit shell for the local dashboard.
/// Serves the bundled dashboard over loopback HTTP, then loads it in a WKWebView.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: LocalServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let rect = NSRect(x: 0, y: 0, width: 1440, height: 1000)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "BooxDrop"
        window.center()
        window.setFrameAutosaveName("BooxDropMainWindow")
        window.minSize = NSSize(width: 900, height: 600)

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: rect, configuration: config)
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        startServerAndLoad()
    }

    private func startServerAndLoad() {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("dashboard") else {
            showError("Dashboard resources missing from the app bundle.")
            return
        }
        do {
            let srv = try LocalServer(root: root, preferredPort: 8899)
            server = srv
            let url = URL(string: "http://127.0.0.1:\(srv.port)/")!
            webView.load(URLRequest(url: url))
        } catch {
            showError("Could not start the local server: \(error.localizedDescription)")
        }
    }

    private func showError(_ msg: String) {
        let html = """
        <html><body style="font:15px -apple-system;padding:40px;background:#0b0f16;color:#e8edf6">
        <h2>BooxDrop</h2><p>\(msg)</p></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { server?.stop() }
}

// MARK: - Minimal loopback static file server

final class LocalServer {
    private var listener: NWListener?
    private let root: URL
    private(set) var port: UInt16 = 0
    private let queue = DispatchQueue(label: "booxdrop.server")

    init(root: URL, preferredPort: UInt16) throws {
        self.root = root
        for candidate in [preferredPort, preferredPort + 1, preferredPort + 2,
                          preferredPort + 3, preferredPort + 4] {
            if let srv = try? start(port: candidate) {
                listener = srv
                port = candidate
                return
            }
        }
        throw NSError(domain: "booxdrop", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "no free port near \(preferredPort)"])
    }

    private func start(port: UInt16) throws -> NWListener {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        l.start(queue: queue)
        let deadline = Date().addingTimeInterval(1.0)
        while l.state != .ready && Date() < deadline {
            if case .failed = l.state { throw NSError(domain: "booxdrop", code: 3) }
            usleep(20_000)
        }
        if l.state != .ready { throw NSError(domain: "booxdrop", code: 4) }
        return l
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] chunk, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let chunk { buf.append(chunk) }
            if let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<headerEnd.lowerBound], as: UTF8.self)
                let line = head.split(separator: "\r\n").first.map(String.init) ?? ""
                self.respond(conn, requestLine: line)
            } else if isComplete || error != nil {
                conn.cancel()
            } else {
                self.receive(conn, buffer: buf)
            }
        }
    }

    private func respond(_ conn: NWConnection, requestLine: String) {
        let parts = requestLine.split(separator: " ")
        var path = parts.count > 1 ? String(parts[1]) : "/"
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        if path == "/" { path = "/index.html" }
        path = path.removingPercentEncoding ?? path
        let cleaned = path.split(separator: "/").filter { $0 != ".." }.joined(separator: "/")
        let fileURL = root.appendingPathComponent(cleaned)

        let data = (try? Data(contentsOf: fileURL)) ?? Data()
        let ext = fileURL.pathExtension.lowercased()
        let mime: String
        switch ext {
        case "html": mime = "text/html; charset=utf-8"
        case "js", "mjs": mime = "text/javascript; charset=utf-8"
        case "css":  mime = "text/css; charset=utf-8"
        case "png":  mime = "image/png"
        case "jpg", "jpeg": mime = "image/jpeg"
        case "gif":  mime = "image/gif"
        case "webp": mime = "image/webp"
        case "svg":  mime = "image/svg+xml"
        case "json": mime = "application/json"
        case "map":  mime = "application/json"
        case "woff2": mime = "font/woff2"
        case "woff":  mime = "font/woff"
        case "ttf":   mime = "font/ttf"
        case "otf":   mime = "font/otf"
        case "wasm":  mime = "application/wasm"
        default:     mime = "application/octet-stream"
        }
        let status = data.isEmpty ? "404 Not Found" : "200 OK"
        var out = Data("HTTP/1.1 \(status)\r\nContent-Type: \(mime)\r\nContent-Length: \(data.count)\r\nConnection: close\r\n\r\n".utf8)
        out.append(data)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
