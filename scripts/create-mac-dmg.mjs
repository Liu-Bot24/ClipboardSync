import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const appPath = join(projectRoot, 'dist/ClipboardSync-darwin-universal/ClipboardSync.app');
const dmgPath = join(projectRoot, 'dist/ClipboardSync-mac-universal.dmg');
const volumeName = 'ClipboardSync';
const appBundleName = 'ClipboardSync.app';
const backgroundWidth = 620;
const backgroundHeight = 360;

export function copyAppForDmg(sourceApp, targetApp, execFileSyncImpl = execFileSync) {
  execFileSyncImpl('/usr/bin/ditto', [sourceApp, targetApp], { stdio: 'inherit' });
}

function getDirectorySizeKb(path) {
  const output = execFileSync('/usr/bin/du', ['-sk', path], { encoding: 'utf8' });
  const sizeKb = Number.parseInt(output.trim().split(/\s+/)[0], 10);
  if (!Number.isFinite(sizeKb) || sizeKb <= 0) {
    throw new Error(`Unable to calculate DMG source size: ${path}`);
  }
  return sizeKb;
}

function getDmgSizeMb(sourceApp) {
  const appSizeMb = Math.ceil(getDirectorySizeKb(sourceApp) / 1024);
  return Math.max(160, appSizeMb + 80);
}

function createBackgroundWithSwift(backgroundPath) {
  const source = `
import AppKit

let output = CommandLine.arguments[1]
let width: CGFloat = ${backgroundWidth}
let height: CGFloat = ${backgroundHeight}
let image = NSImage(size: NSSize(width: width, height: height))

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
}

image.lockFocus()
let bounds = NSRect(x: 0, y: 0, width: width, height: height)
let gradient = NSGradient(starting: color(248, 250, 252), ending: color(232, 245, 243))
gradient?.draw(in: bounds, angle: -40)

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center

let titleAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 24, weight: .semibold),
    .foregroundColor: color(17, 24, 39),
    .paragraphStyle: paragraph
]
let subtitleAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 15, weight: .medium),
    .foregroundColor: color(71, 85, 105),
    .paragraphStyle: paragraph
]

("拖到 Applications 安装" as NSString).draw(
    in: NSRect(x: 0, y: 300, width: width, height: 34),
    withAttributes: titleAttributes
)
("Drag to Applications" as NSString).draw(
    in: NSRect(x: 0, y: 268, width: width, height: 24),
    withAttributes: subtitleAttributes
)

let arrowColor = color(20, 184, 166)
arrowColor.setFill()
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 238, y: 146))
arrow.line(to: NSPoint(x: 332, y: 146))
arrow.line(to: NSPoint(x: 332, y: 122))
arrow.line(to: NSPoint(x: 392, y: 158))
arrow.line(to: NSPoint(x: 332, y: 194))
arrow.line(to: NSPoint(x: 332, y: 170))
arrow.line(to: NSPoint(x: 238, y: 170))
arrow.close()
arrow.fill()

image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let png = bitmap.representation(using: .png, properties: [:])
else {
    fatalError("Unable to render DMG background")
}

try png.write(to: URL(fileURLWithPath: output))
`;
  execFileSync('/usr/bin/swift', ['-', backgroundPath], {
    input: source,
    stdio: ['pipe', 'inherit', 'inherit']
  });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createFallbackBackground(backgroundPath) {
  const rows = [];
  for (let y = 0; y < backgroundHeight; y += 1) {
    const row = Buffer.alloc(1 + backgroundWidth * 3);
    row[0] = 0;
    for (let x = 0; x < backgroundWidth; x += 1) {
      const offset = 1 + x * 3;
      let red = 248 - Math.round((y / backgroundHeight) * 12);
      let green = 250 - Math.round((y / backgroundHeight) * 5);
      let blue = 252 - Math.round((y / backgroundHeight) * 8);
      const inArrowShaft = x >= 238 && x <= 332 && y >= 170 && y <= 194;
      const inArrowHead = x >= 332 && x <= 392 && Math.abs(y - 182) <= (392 - x) * 0.6;
      if (inArrowShaft || inArrowHead) {
        red = 20;
        green = 184;
        blue = 166;
      }
      row[offset] = red;
      row[offset + 1] = green;
      row[offset + 2] = blue;
    }
    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(backgroundWidth, 0);
  header.writeUInt32BE(backgroundHeight, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  writeFileSync(
    backgroundPath,
    Buffer.concat([
      Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0))
    ])
  );
}

function createDmgBackground(backgroundPath) {
  try {
    createBackgroundWithSwift(backgroundPath);
  } catch (error) {
    createFallbackBackground(backgroundPath);
  }
}

function configureDmgWindow() {
  const script = `
tell application "Finder"
  tell disk "${volumeName}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {120, 120, 740, 480}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 96
    set background picture of viewOptions to file ".background:background.png"
    set position of item "${appBundleName}" of container window to {160, 200}
    set position of item "Applications" of container window to {460, 200}
    update without registering applications
    delay 1
    close
  end tell
end tell
`;
  execFileSync('/usr/bin/osascript', [], {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit']
  });
}

function attachTemporaryDmg(temporaryDmg, staging) {
  const attachPlistPath = join(staging, 'attach.plist');
  const attachPlist = execFileSync('/usr/bin/hdiutil', [
    'attach',
    '-readwrite',
    '-noverify',
    '-noautoopen',
    '-plist',
    temporaryDmg
  ]);
  writeFileSync(attachPlistPath, attachPlist);
  const attachJson = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', attachPlistPath], {
    encoding: 'utf8'
  });
  const payload = JSON.parse(attachJson);
  const entity = payload['system-entities']?.find((item) => item['mount-point']);
  if (!entity?.['mount-point']) {
    throw new Error('Unable to find mounted DMG volume');
  }
  return entity['mount-point'];
}

function detachVolume(target, { force = false } = {}) {
  if (!existsSync(target)) {
    return;
  }
  try {
    execFileSync('/usr/bin/hdiutil', ['detach', target], { stdio: 'ignore' });
  } catch {
    if (!force) {
      throw new Error(`Unable to detach ${target}. Close ClipboardSync from the mounted DMG and eject the volume first.`);
    }
    try {
      execFileSync('/usr/bin/hdiutil', ['detach', '-force', target], { stdio: 'ignore' });
    } catch {
      // The cleanup path may run after a successful detach.
    }
  }
}

export function createMacDmg({
  sourceApp = appPath,
  outputDmg = dmgPath,
  stagingRoot = tmpdir()
} = {}) {
  if (!existsSync(sourceApp)) {
    throw new Error(`Missing Mac app bundle: ${sourceApp}`);
  }

  const staging = mkdtempSync(join(stagingRoot, 'clipboardsync-dmg-'));
  const temporaryDmg = join(staging, 'ClipboardSync.tmp.dmg');
  const mountedVolume = join('/Volumes', volumeName);
  let mountPoint = '';
  try {
    mkdirSync(dirname(outputDmg), { recursive: true });
    rmSync(outputDmg, { force: true });

    detachVolume(mountedVolume);
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'create',
        '-volname',
        volumeName,
        '-size',
        `${getDmgSizeMb(sourceApp)}m`,
        '-fs',
        'HFS+',
        '-type',
        'UDIF',
        '-ov',
        temporaryDmg
      ],
      { stdio: 'inherit' }
    );

    mountPoint = attachTemporaryDmg(temporaryDmg, staging);

    copyAppForDmg(sourceApp, join(mountPoint, appBundleName));
    symlinkSync('/Applications', join(mountPoint, 'Applications'));

    const backgroundDir = join(mountPoint, '.background');
    mkdirSync(backgroundDir);
    createDmgBackground(join(backgroundDir, 'background.png'));
    execFileSync('/usr/bin/chflags', ['hidden', backgroundDir], { stdio: 'ignore' });
    if (existsSync('/usr/bin/SetFile')) {
      execFileSync('/usr/bin/SetFile', ['-a', 'V', backgroundDir], { stdio: 'ignore' });
    }

    configureDmgWindow();
    rmSync(join(mountPoint, '.fseventsd'), { force: true, recursive: true });
    rmSync(join(mountPoint, '.Trashes'), { force: true, recursive: true });
    execFileSync('/bin/sync');
    detachVolume(mountPoint);
    mountPoint = '';

    execFileSync(
      '/usr/bin/hdiutil',
      ['convert', temporaryDmg, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', outputDmg],
      { stdio: 'inherit' }
    );
  } finally {
    detachVolume(mountPoint, { force: true });
    rmSync(staging, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createMacDmg();
}
