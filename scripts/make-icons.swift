import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let assetDir = root.appendingPathComponent("assets")
try FileManager.default.createDirectory(at: assetDir, withIntermediateDirectories: true)

func drawIcon(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    let rect = NSRect(x: 0, y: 0, width: size, height: size)
    let radius = size * 0.23
    let base = NSBezierPath(roundedRect: rect.insetBy(dx: size * 0.055, dy: size * 0.055), xRadius: radius, yRadius: radius)
    NSColor(calibratedRed: 0.07, green: 0.09, blue: 0.13, alpha: 1).setFill()
    base.fill()

    let glow = NSGradient(colors: [
        NSColor(calibratedRed: 0.08, green: 0.72, blue: 0.63, alpha: 0.92),
        NSColor(calibratedRed: 0.95, green: 0.57, blue: 0.19, alpha: 0.86)
    ])!
    glow.draw(in: base, angle: 36)

    NSColor(calibratedWhite: 1, alpha: 0.13).setFill()
    NSBezierPath(roundedRect: rect.insetBy(dx: size * 0.09, dy: size * 0.09), xRadius: radius * 0.82, yRadius: radius * 0.82).fill()

    let board = NSBezierPath(roundedRect: NSRect(x: size * 0.28, y: size * 0.2, width: size * 0.44, height: size * 0.58), xRadius: size * 0.07, yRadius: size * 0.07)
    NSColor(calibratedRed: 0.96, green: 0.98, blue: 0.99, alpha: 0.96).setFill()
    board.fill()

    let clip = NSBezierPath(roundedRect: NSRect(x: size * 0.38, y: size * 0.69, width: size * 0.24, height: size * 0.1), xRadius: size * 0.045, yRadius: size * 0.045)
    NSColor(calibratedRed: 0.09, green: 0.12, blue: 0.18, alpha: 0.88).setFill()
    clip.fill()

    let lineColor = NSColor(calibratedRed: 0.08, green: 0.55, blue: 0.52, alpha: 0.95)
    lineColor.setStroke()
    for offset in [0.43, 0.53] {
        let path = NSBezierPath()
        path.lineWidth = size * 0.035
        path.lineCapStyle = .round
        path.move(to: NSPoint(x: size * 0.38, y: size * offset))
        path.line(to: NSPoint(x: size * 0.62, y: size * offset))
        path.stroke()
    }

    let arrowColor = NSColor(calibratedRed: 0.96, green: 0.62, blue: 0.21, alpha: 0.95)
    arrowColor.setStroke()
    let arrow = NSBezierPath()
    arrow.lineWidth = size * 0.04
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: size * 0.22, y: size * 0.46))
    arrow.curve(to: NSPoint(x: size * 0.33, y: size * 0.61), controlPoint1: NSPoint(x: size * 0.2, y: size * 0.57), controlPoint2: NSPoint(x: size * 0.25, y: size * 0.63))
    arrow.move(to: NSPoint(x: size * 0.78, y: size * 0.54))
    arrow.curve(to: NSPoint(x: size * 0.67, y: size * 0.39), controlPoint1: NSPoint(x: size * 0.8, y: size * 0.43), controlPoint2: NSPoint(x: size * 0.75, y: size * 0.37))
    arrow.stroke()

    image.unlockFocus()
    return image
}

func drawTrayIcon(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: size, height: size).fill()

    NSColor(calibratedWhite: 0, alpha: 1).setFill()

    let icon = NSBezierPath()
    icon.windingRule = .evenOdd
    icon.appendRoundedRect(
        NSRect(x: size * 0.16, y: size * 0.12, width: size * 0.68, height: size * 0.76),
        xRadius: size * 0.045,
        yRadius: size * 0.045
    )
    icon.append(
        NSBezierPath(roundedRect: NSRect(x: size * 0.25, y: size * 0.22, width: size * 0.5, height: size * 0.5), xRadius: size * 0.01, yRadius: size * 0.01)
    )
    icon.fill()

    let clip = NSBezierPath()
    clip.windingRule = .evenOdd
    clip.append(NSBezierPath(roundedRect: NSRect(x: size * 0.31, y: size * 0.68, width: size * 0.38, height: size * 0.2), xRadius: size * 0.025, yRadius: size * 0.025))
    clip.append(NSBezierPath(roundedRect: NSRect(x: size * 0.4, y: size * 0.76, width: size * 0.2, height: size * 0.065), xRadius: size * 0.012, yRadius: size * 0.012))
    clip.fill()

    image.unlockFocus()
    return image
}

func writePNG(_ image: NSImage, to url: URL) throws {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "Icon", code: 1)
    }
    try png.write(to: url)
}

try writePNG(drawIcon(size: 1024), to: assetDir.appendingPathComponent("app-icon.png"))
try writePNG(drawTrayIcon(size: 64), to: root.appendingPathComponent("src/client/tray-icon.png"))
try writePNG(drawIcon(size: 64), to: root.appendingPathComponent("src/client/tray-icon-win.png"))

let iconset = assetDir.appendingPathComponent("ClipboardSync.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

let sizes: [(String, CGFloat)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)
]

for (name, size) in sizes {
    try writePNG(drawIcon(size: size), to: iconset.appendingPathComponent(name))
}
