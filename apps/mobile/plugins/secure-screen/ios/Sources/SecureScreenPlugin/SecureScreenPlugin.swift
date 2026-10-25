import Capacitor
import UIKit

/// Screenshot / screen-recording protection for iOS.
///
/// iOS has no FLAG_SECURE, so the web view's layer is re-parented into the secure canvas of a
/// `UITextField` with `isSecureTextEntry = true`. The system omits that canvas from screenshots,
/// screen recordings and AirPlay mirroring (they show an empty view). Capture state changes and
/// screenshot events are reported to JS, and a blur covers the UI in the app switcher.
@objc(SecureScreenPlugin)
public class SecureScreenPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureScreenPlugin"
    public let jsName = "SecureScreen"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isCaptured", returnType: CAPPluginReturnPromise),
    ]

    private var secureField: UITextField?
    private var shield: UIView?

    override public func load() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(onScreenshot), name: UIApplication.userDidTakeScreenshotNotification, object: nil)
        nc.addObserver(self, selector: #selector(onCaptureChanged), name: UIScreen.capturedDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(onResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(onBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        DispatchQueue.main.async { self.applySecureLayer() }
    }

    @objc func enable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.applySecureLayer()
            call.resolve()
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let field = self.secureField, let webView = self.bridge?.webView, let host = field.superview {
                host.layer.addSublayer(webView.layer)
                field.removeFromSuperview()
            }
            self.secureField = nil
            call.resolve()
        }
    }

    @objc func isCaptured(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["captured": UIScreen.main.isCaptured])
        }
    }

    private func applySecureLayer() {
        guard secureField == nil, let webView = bridge?.webView, let host = webView.superview else { return }
        let field = UITextField()
        field.isSecureTextEntry = true
        field.isUserInteractionEnabled = false
        field.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(field)
        NSLayoutConstraint.activate([
            field.centerXAnchor.constraint(equalTo: host.centerXAnchor),
            field.centerYAnchor.constraint(equalTo: host.centerYAnchor),
        ])
        host.layer.superlayer?.addSublayer(field.layer)
        // The secure canvas is the text field's first sublayer on iOS 15–18.
        if let canvas = field.layer.sublayers?.first {
            canvas.addSublayer(webView.layer)
        }
        secureField = field
        updateCaptureShield()
    }

    private func setShield(_ on: Bool) {
        guard let window = bridge?.webView?.window else { return }
        if on, shield == nil {
            let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
            blur.frame = window.bounds
            blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            let logo = UIImageView(image: UIImage(systemName: "lock.fill"))
            logo.tintColor = UIColor(red: 0, green: 0.66, blue: 0.56, alpha: 1)
            logo.contentMode = .scaleAspectFit
            logo.frame = CGRect(x: 0, y: 0, width: 56, height: 56)
            logo.center = CGPoint(x: blur.bounds.midX, y: blur.bounds.midY)
            logo.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleTopMargin, .flexibleBottomMargin]
            blur.contentView.addSubview(logo)
            window.addSubview(blur)
            shield = blur
        } else if !on {
            shield?.removeFromSuperview()
            shield = nil
        }
    }

    private func updateCaptureShield() {
        setShield(UIScreen.main.isCaptured)
    }

    @objc private func onScreenshot() {
        notifyListeners("screenshotTaken", data: [:])
    }

    @objc private func onCaptureChanged() {
        DispatchQueue.main.async {
            self.updateCaptureShield()
            self.notifyListeners("captureChanged", data: ["captured": UIScreen.main.isCaptured])
        }
    }

    @objc private func onResignActive() {
        DispatchQueue.main.async { self.setShield(true) }
    }

    @objc private func onBecomeActive() {
        DispatchQueue.main.async { self.updateCaptureShield() }
    }
}
