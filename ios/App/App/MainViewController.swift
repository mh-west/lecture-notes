import Capacitor
import UIKit

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LectureAudioPlugin())
    }

    // The top strip is white, so keep the clock and battery dark even in dark mode.
    override var preferredStatusBarStyle: UIStatusBarStyle { .darkContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Keep the web page out of the strip under the status bar / window controls. A WKWebView there
        // takes every tap, so iPadOS never sees the double-tap on a window's top edge that resizes it.
        guard let web = webView else { return }
        let container = TopStripView(content: web)
        container.frame = view.frame
        view = container
    }
}

/// Holds the web view below the top safe-area strip, which stays a plain (gesture-free) native view.
final class TopStripView: UIView {
    private let content: UIView

    init(content: UIView) {
        self.content = content
        super.init(frame: .zero)
        backgroundColor = .white // matches the toolbar; .systemBackground turns black in dark mode
        addSubview(content)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let top = max(safeAreaInsets.top, 20)
        content.frame = CGRect(x: 0, y: top, width: bounds.width, height: bounds.height - top)
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }
}
