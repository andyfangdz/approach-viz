import CoreGraphics
import MetalKit

#if os(iOS)
import UIKit

typealias PlatformColor = UIColor
typealias PlatformFont = UIFont
typealias PlatformImage = UIImage
typealias PlatformGestureState = UIGestureRecognizer.State

@MainActor
func platformMaximumFramesPerSecond() -> Int {
    UIScreen.main.maximumFramesPerSecond
}

func platformColor(red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) -> PlatformColor {
    PlatformColor(red: red, green: green, blue: blue, alpha: alpha)
}

func platformWhiteColor() -> PlatformColor {
    .white
}

func platformMonospacedFont(ofSize size: CGFloat, weight: PlatformFont.Weight) -> PlatformFont {
    .monospacedSystemFont(ofSize: size, weight: weight)
}

func withPlatformGraphicsContext(_ context: CGContext, draw: () -> Void) {
    UIGraphicsPushContext(context)
    draw()
    UIGraphicsPopContext()
}

func platformCGImage(from image: PlatformImage) -> CGImage? {
    image.cgImage
}

func platformColorComponents(_ color: PlatformColor) -> (red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) {
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    return (red, green, blue, alpha)
}

@MainActor
func platformRequestDisplay(for view: MTKView) {
    view.setNeedsDisplay()
}
#elseif os(macOS)
import AppKit

typealias PlatformColor = NSColor
typealias PlatformFont = NSFont
typealias PlatformImage = NSImage
typealias PlatformGestureState = NSGestureRecognizer.State

@MainActor
func platformMaximumFramesPerSecond() -> Int {
    NSScreen.main?.maximumFramesPerSecond ?? 60
}

func platformColor(red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) -> PlatformColor {
    PlatformColor(calibratedRed: red, green: green, blue: blue, alpha: alpha)
}

func platformWhiteColor() -> PlatformColor {
    .white
}

func platformMonospacedFont(ofSize size: CGFloat, weight: PlatformFont.Weight) -> PlatformFont {
    .monospacedSystemFont(ofSize: size, weight: weight)
}

func withPlatformGraphicsContext(_ context: CGContext, draw: () -> Void) {
    let previous = NSGraphicsContext.current
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
    draw()
    NSGraphicsContext.current = previous
}

func platformCGImage(from image: PlatformImage) -> CGImage? {
    var proposedRect = CGRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)
}

func platformColorComponents(_ color: PlatformColor) -> (red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) {
    let resolved = color.usingColorSpace(.deviceRGB) ?? color
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    return (red, green, blue, alpha)
}

@MainActor
func platformRequestDisplay(for view: MTKView) {
    view.setNeedsDisplay(view.bounds)
}
#endif
