import { join } from 'node:path';

// The Mac client ships for Apple Silicon by default. A universal build carries
// a second copy of Electron and roughly doubles the app on disk. Set
// CLIPBOARD_SYNC_MAC_ARCH=x64 (Intel) or universal to build another target.
export const MAC_ARCHES = ['arm64', 'x64', 'universal'];

export function macArch(env = process.env) {
  const arch = env.CLIPBOARD_SYNC_MAC_ARCH || 'arm64';
  if (!MAC_ARCHES.includes(arch)) {
    throw new Error(`CLIPBOARD_SYNC_MAC_ARCH must be one of ${MAC_ARCHES.join(', ')}`);
  }
  return arch;
}

export function macBuildDirName(arch = macArch()) {
  return `ClipboardSync-darwin-${arch}`;
}

export function macAppPath(projectRoot, arch = macArch()) {
  return join(projectRoot, 'dist', macBuildDirName(arch), 'ClipboardSync.app');
}

export function macResourcesPath(projectRoot, arch = macArch()) {
  return join(macAppPath(projectRoot, arch), 'Contents/Resources');
}

export function macDmgName(arch = macArch()) {
  return `ClipboardSync-mac-${arch}.dmg`;
}

export function macDmgPath(projectRoot, arch = macArch()) {
  return join(projectRoot, 'dist', macDmgName(arch));
}

export function clangArchArgs(arch = macArch()) {
  if (arch === 'universal') return ['-arch', 'arm64', '-arch', 'x86_64'];
  return ['-arch', arch === 'x64' ? 'x86_64' : 'arm64'];
}
