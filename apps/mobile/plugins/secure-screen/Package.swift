// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VeilSecureScreen",
    platforms: [.iOS(.v13)],
    products: [.library(name: "VeilSecureScreen", targets: ["SecureScreenPlugin"])],
    dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "6.0.0")],
    targets: [
        .target(
            name: "SecureScreenPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/SecureScreenPlugin"
        )
    ]
)
