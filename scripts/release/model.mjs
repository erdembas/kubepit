import { createHash } from 'node:crypto';

export const targets = [
  {
    id: 'macos-arm64',
    runner: 'macos-14',
    target: 'aarch64-apple-darwin',
    platform: 'macos',
    arch: 'arm64',
    formats: ['dmg'],
  },
  {
    id: 'macos-x64',
    runner: 'macos-14',
    target: 'x86_64-apple-darwin',
    platform: 'macos',
    arch: 'x64',
    formats: ['dmg'],
  },
  {
    id: 'linux-x64',
    runner: 'ubuntu-22.04',
    target: 'x86_64-unknown-linux-gnu',
    platform: 'linux',
    arch: 'x64',
    formats: ['AppImage', 'deb', 'rpm'],
  },
  {
    id: 'linux-arm64',
    runner: 'ubuntu-22.04-arm',
    target: 'aarch64-unknown-linux-gnu',
    platform: 'linux',
    arch: 'arm64',
    formats: ['AppImage', 'deb', 'rpm'],
  },
  {
    id: 'windows-x64',
    runner: 'windows-2022',
    target: 'x86_64-pc-windows-msvc',
    platform: 'windows',
    arch: 'x64',
    formats: ['nsis', 'msi'],
  },
  {
    id: 'windows-arm64',
    runner: 'windows-2022',
    target: 'aarch64-pc-windows-msvc',
    platform: 'windows',
    arch: 'arm64',
    formats: ['nsis'],
  },
];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
export function assetName(version, target, format) {
  assert(versionPattern.test(version), 'Invalid version');
  assert(target.formats.includes(format), 'Unsupported target/format');
  return `Kubepit_${version}_${target.platform}_${target.arch}${format === 'nsis' ? '-setup.exe' : `.${format}`}`;
}
export function checkMagic(bytes, format, arch) {
  assert(bytes.length >= 1024, 'Installer is empty or too small');
  const hex = bytes.subarray(0, 8).toString('hex');
  if (format === 'dmg')
    assert(bytes.subarray(-512, -508).toString() === 'koly', 'Invalid DMG trailer');
  if (format === 'deb')
    assert(bytes.subarray(0, 8).toString() === '!<arch>\n', 'Invalid Debian archive');
  if (format === 'rpm') assert(hex.startsWith('edabeedb'), 'Invalid RPM archive');
  if (format === 'msi') assert(hex === 'd0cf11e0a1b11ae1', 'Invalid MSI compound file');
  if (format === 'nsis')
    assert(bytes.subarray(0, 2).toString() === 'MZ', 'Invalid Windows installer');
  if (format === 'AppImage') {
    assert(
      hex.startsWith('7f454c46') && bytes.subarray(8, 11).equals(Buffer.from([65, 73, 2])),
      'Invalid type-2 AppImage',
    );
    assert(
      bytes.readUInt16LE(18) === (arch === 'arm64' ? 183 : 62),
      'AppImage architecture mismatch',
    );
  }
}
export function homebrewCask(manifest) {
  const mac = Object.fromEntries(
    manifest.assets
      .filter((a) => a.platform === 'macos' && a.format === 'dmg')
      .map((a) => [a.arch, a]),
  );
  assert(mac.arm64 && mac.x64, 'Both macOS DMGs are required for Homebrew');
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repository), 'Invalid repository');
  assert(versionPattern.test(manifest.version), 'Invalid cask version');
  for (const a of Object.values(mac))
    assert(/^[a-f0-9]{64}$/.test(a.sha256), 'Invalid cask checksum');
  return `cask "kubepit" do
  arch arm: "arm64", intel: "x64"

  version "${manifest.version}"
  sha256 arm:   "${mac.arm64.sha256}",
         intel: "${mac.x64.sha256}"

  url "https://github.com/${manifest.repository}/releases/download/v#{version}/Kubepit_#{version}_macos_#{arch}.dmg",
      verified: "github.com/${manifest.repository}/"

  name "Kubepit"
  desc "Local-first Kubernetes IDE"
  homepage "https://${manifest.repository.split('/')[0]}.github.io/${manifest.repository.split('/')[1]}/"

  depends_on macos: ">= :big_sur"
  app "Kubepit.app"

  zap trash: [
    "~/Library/Caches/io.github.erdembas.kubepit",
    "~/Library/Preferences/io.github.erdembas.kubepit.plist",
    "~/Library/Saved Application State/io.github.erdembas.kubepit.savedState",
  ]
end
`;
}
