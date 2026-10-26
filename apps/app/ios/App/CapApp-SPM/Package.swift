// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v18)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(name: "CapacitorCommunitySqlite", path: "../../../../../node_modules/@capacitor-community/sqlite"),
        .package(name: "CapacitorFilesystem", path: "../../../../../node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorNetwork", path: "../../../../../node_modules/@capacitor/network"),
        .package(name: "CapacitorPreferences", path: "../../../../../node_modules/@capacitor/preferences"),
        .package(name: "CapawesomeCapacitorFilePicker", path: "../../../../../node_modules/@capawesome/capacitor-file-picker"),
        .package(name: "CapacitorPluginPlaylist", path: "../../../../../node_modules/capacitor-plugin-playlist")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorCommunitySqlite", package: "CapacitorCommunitySqlite"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorNetwork", package: "CapacitorNetwork"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "CapawesomeCapacitorFilePicker", package: "CapawesomeCapacitorFilePicker"),
                .product(name: "CapacitorPluginPlaylist", package: "CapacitorPluginPlaylist")
            ]
        )
    ]
)
