'use client';

import { useEffect, useState } from 'react';
import {
  Apple,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  FileCode2,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import * as i18n from '@/i18n';
import { demo, repository } from '@/lib/links';
import snapshotData from '@/lib/releases/snapshot.json';
import {
  detectPlatform,
  readReleaseSnapshot,
  selectRelease,
  type Architecture,
  type Installer,
  type Platform,
  type ReleaseChannel,
} from '@/lib/releases/model.mjs';
import { loadPublishedReleases, type ReleaseLoadResult } from '@/lib/releases/load.mjs';
import styles from './Downloads.module.css';

const snapshot = readReleaseSnapshot(snapshotData);
const platformNames = { macos: 'macOS', windows: 'Windows', linux: 'Linux' } as const;
const platformIcons = { macos: Apple, windows: Monitor, linux: Terminal };
const formatNames = {
  dmg: 'DMG',
  AppImage: 'AppImage',
  deb: 'DEB',
  rpm: 'RPM',
  nsis: 'EXE',
  msi: 'MSI',
} as const;
const formatOrder = { dmg: 0, AppImage: 0, nsis: 0, deb: 1, msi: 1, rpm: 2 };

export function Downloads() {
  const { locale, t } = i18n.useLocale();
  const [data, setData] = useState<ReleaseLoadResult>({
    releases: snapshot.releases,
    homebrew: null,
    status: 'snapshot',
    checkedAt: snapshot.checkedAt,
  });
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [platform, setPlatform] = useState<Platform>('macos');
  const [architecture, setArchitecture] = useState<Architecture | null>(null);
  const [channel, setChannel] = useState<ReleaseChannel>(() =>
    snapshot.releases.some((release) => !release.prerelease) ? 'stable' : 'prerelease',
  );
  const [channelChosen, setChannelChosen] = useState(false);
  const [format, setFormat] = useState<Installer['format'] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const release = selectRelease(data.releases, channel);
  const hasStable = data.releases.some((item) => !item.prerelease);
  const hasPreview = data.releases.some((item) => item.prerelease);
  const platformAssets = release?.assets.filter((item) => item.platform === platform) ?? [];
  const architectures = [...new Set(platformAssets.map((item) => item.arch))].sort();
  const packages = platformAssets
    .filter((item) => item.arch === architecture)
    .sort((a, b) => formatOrder[a.format] - formatOrder[b.format]);
  const selected = packages.find((item) => item.format === format) ?? packages[0] ?? null;
  const setup = `${repository}/blob/main/${locale === 'tr' ? 'docs/README.tr.md#masaüstü-uygulamasını-çalıştırın' : 'README.md#run-the-desktop-app'}`;
  const homebrew = data.homebrew?.version === release?.version ? data.homebrew : null;

  useEffect(() => {
    const hint = detectPlatform(navigator.userAgent);
    if (hint) setPlatform(hint);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void loadPublishedReleases(snapshot, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setData(result);
      setLoading(false);
    });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const chosenChannelDisappeared =
      (channel === 'stable' && !hasStable && hasPreview) ||
      (channel === 'prerelease' && !hasPreview && hasStable);
    if (!channelChosen || chosenChannelDisappeared) setChannel(hasStable ? 'stable' : 'prerelease');
  }, [hasStable, hasPreview, channelChosen, channel]);

  async function copy(value: string, id: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setCopyFailed(false);
    } catch {
      setCopied(null);
      setCopyFailed(true);
    }
  }
  function architectureLabel(arch: Architecture) {
    if (platform === 'macos') return arch === 'arm64' ? t('Apple Silicon') : t('Intel');
    return arch === 'arm64' ? 'ARM64' : 'x64';
  }
  function signingLabel(signing: Installer['signing']) {
    if (signing === 'notarized') return t('Signed and notarized');
    if (signing === 'signed') return t('Code signed');
    if (signing === 'ad-hoc') return t('Ad-hoc signature');
    return t('Unsigned package');
  }
  function signingDetail(signing: Installer['signing']) {
    if (signing === 'notarized')
      return t('The release workflow reports macOS signing and notarization.');
    if (signing === 'signed') return t('The release workflow reports a platform code signature.');
    if (signing === 'ad-hoc')
      return t(
        'This macOS build is not Developer ID signed or notarized. macOS may block installation; read the release notes.',
      );
    return t(
      'This package has no platform code signature. Read the release notes before installing.',
    );
  }
  function statusText() {
    if (loading) return t('Checking published packages…');
    if (data.status === 'snapshot')
      return t('GitHub could not be reached. Showing the release details saved with this site.');
    if (data.status === 'unavailable')
      return t('Release availability could not be checked. No download links are shown.');
    if (data.status === 'partial')
      return t('Some release details could not be refreshed. Only matched packages are shown.');
    if (data.releases.length === 0) return t('No published installer metadata is available yet.');
    return t('Packages matched to published GitHub assets and checksums.');
  }
  const publishedDate = release
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(release.publishedAt),
      )
    : null;
  const checkedDate = data.checkedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(data.checkedAt),
      )
    : null;

  return (
    <section
      className={`section container ${styles.section}`}
      id="downloads"
      aria-labelledby="downloads-heading"
    >
      <div className={styles.heading}>
        <div>
          <p className="eyebrow">{t('DESKTOP DOWNLOADS')}</p>
          <h2 id="downloads-heading">
            {t('Your next workspace.')}
            <br />
            <span className="muted">{t('Ready for your machine.')}</span>
          </h2>
        </div>
        <p>
          {t(
            'Choose your system and processor. Every download here corresponds to a published package, with its version, checksum and signing status shown.',
          )}
        </p>
      </div>
      <div className={styles.panel}>
        <div className={styles.releaseBar}>
          <div className={styles.releaseIdentity}>
            <span className={styles.releaseDot} />
            {release ? (
              <>
                <strong>Kubepit {release.version}</strong>
                <span className={styles.channelBadge}>
                  {release.prerelease ? t('Pre-release') : t('Stable release')}
                </span>
              </>
            ) : (
              <strong>{t('Published desktop packages')}</strong>
            )}
            {publishedDate && <time dateTime={release?.publishedAt}>{publishedDate}</time>}
          </div>
          {hasStable && hasPreview && (
            <label className={styles.channelPicker}>
              <span>{t('Release channel')}</span>
              <select
                value={channel}
                onChange={(event) => {
                  setChannel(event.target.value as ReleaseChannel);
                  setChannelChosen(true);
                }}
              >
                <option value="stable">{t('Stable release')}</option>
                <option value="prerelease">{t('Pre-release')}</option>
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
          )}
        </div>
        <div className={styles.statusBar}>
          <p role="status">
            <RefreshCw size={12} className={loading ? styles.spinning : ''} aria-hidden="true" />
            {statusText()}
          </p>
          <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>
            {t('Check again')}
          </button>
        </div>
        {data.status === 'snapshot' && checkedDate && !loading && (
          <p className={styles.snapshotNote}>
            {t('Site snapshot checked on {date}. Confirm availability in the release notes.', {
              date: checkedDate,
            })}
          </p>
        )}
        {release ? (
          <>
            <div className={styles.systems} aria-label={t('Choose your operating system')}>
              {(['macos', 'windows', 'linux'] as const).map((system) => {
                const Icon = platformIcons[system];
                return (
                  <button
                    key={system}
                    type="button"
                    className={platform === system ? styles.systemActive : ''}
                    aria-pressed={platform === system}
                    onClick={() => {
                      setPlatform(system);
                      setArchitecture(null);
                      setFormat(null);
                    }}
                  >
                    <Icon size={19} aria-hidden="true" />
                    {platformNames[system]}
                    <span>
                      {release.assets.some((asset) => asset.platform === system)
                        ? t('Available')
                        : t('No package yet')}
                    </span>
                  </button>
                );
              })}
            </div>
            <div
              className={`${styles.body} ${platformAssets.length === 0 ? styles.unavailableBody : ''}`}
            >
              <div className={styles.choices}>
                {architectures.length > 0 && (
                  <fieldset className={styles.fieldset}>
                    <legend>{t('Choose your processor')}</legend>
                    <div className={styles.processorChoices}>
                      {architectures.map((arch) => (
                        <button
                          key={arch}
                          type="button"
                          aria-pressed={architecture === arch}
                          className={architecture === arch ? styles.choiceActive : ''}
                          onClick={() => {
                            setArchitecture(arch);
                            setFormat(null);
                          }}
                        >
                          <span>{architectureLabel(arch)}</span>
                          <small>{arch === 'arm64' ? 'aarch64' : 'x86_64'}</small>
                          {architecture === arch && <Check size={14} aria-hidden="true" />}
                        </button>
                      ))}
                    </div>
                    {architectures.length > 0 && (
                      <p className={styles.hint}>
                        {t(
                          'Select the processor used by your computer. Browser detection cannot reliably identify its architecture.',
                        )}
                      </p>
                    )}
                  </fieldset>
                )}
                {packages.length > 1 && (
                  <fieldset className={styles.fieldset}>
                    <legend>{t('Package format')}</legend>
                    <div className={styles.formats}>
                      {packages.map((asset) => (
                        <button
                          type="button"
                          key={asset.name}
                          className={selected?.name === asset.name ? styles.formatActive : ''}
                          aria-pressed={selected?.name === asset.name}
                          onClick={() => setFormat(asset.format)}
                        >
                          {formatNames[asset.format]}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                )}
                {selected && (
                  <div className={styles.signing}>
                    <ShieldCheck size={15} aria-hidden="true" />
                    <div>
                      <strong>{signingLabel(selected.signing)}</strong>
                      <p>{signingDetail(selected.signing)}</p>
                    </div>
                  </div>
                )}
                {release.prerelease && (
                  <p className={styles.previewNote}>
                    <TriangleAlert size={14} aria-hidden="true" />
                    {t(
                      'This is a pre-release. Start with a development environment and restricted credentials.',
                    )}
                  </p>
                )}
              </div>
              <div className={styles.package}>
                {selected ? (
                  <>
                    <span className={styles.packageCaption}>{t('YOUR PACKAGE')}</span>
                    <div className={styles.packageTitle}>
                      <FileCode2 size={24} aria-hidden="true" />
                      <div>
                        <h3>
                          {platformNames[platform]} · {architectureLabel(selected.arch)}
                        </h3>
                        <span>
                          {formatNames[selected.format]} ·{' '}
                          {new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
                            selected.size / 1024 / 1024,
                          )}{' '}
                          MiB
                        </span>
                      </div>
                    </div>
                    <p className={styles.filename}>{selected.name}</p>
                    <a className={styles.downloadButton} href={selected.url}>
                      <ArrowDownToLine size={17} aria-hidden="true" />
                      {t('Download {format}', { format: formatNames[selected.format] })}
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </a>
                    <details className={styles.checksum} key={selected.name}>
                      <summary>
                        {t('Verify SHA-256')}
                        <ChevronDown size={13} aria-hidden="true" />
                      </summary>
                      <code>{selected.sha256}</code>
                      <button type="button" onClick={() => copy(selected.sha256, selected.name)}>
                        {copied === selected.name ? (
                          <CheckCheck size={13} aria-hidden="true" />
                        ) : (
                          <Copy size={13} aria-hidden="true" />
                        )}
                        {copied === selected.name ? t('Checksum copied') : t('Copy checksum')}
                      </button>
                      <p>
                        {t(
                          'Compare this checksum with your downloaded file. This page does not inspect downloads on your computer.',
                        )}
                      </p>
                    </details>
                  </>
                ) : (
                  <div className={styles.emptyPackage}>
                    <ArrowDownToLine size={28} aria-hidden="true" />
                    <h3>
                      {platformAssets.length
                        ? t('One more choice.')
                        : t('No package for this system yet.')}
                    </h3>
                    <p>
                      {platformAssets.length
                        ? t('Select your processor to see the available download.')
                        : t(
                            'A package is shown only after it has been published with matching release metadata. You can still use the browser demo or build from source.',
                          )}
                    </p>
                  </div>
                )}
              </div>
            </div>
            {platform === 'macos' && homebrew && (
              <div className={styles.homebrew}>
                <div>
                  <Terminal size={17} aria-hidden="true" />
                  <strong>{t('Or install with Homebrew')}</strong>
                  <a href={homebrew.url}>
                    {t('View the verified cask')}
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </a>
                </div>
                <div className={styles.brewCommand}>
                  <code>{homebrew.command}</code>
                  <button
                    type="button"
                    onClick={() => copy(homebrew.command, 'homebrew')}
                    aria-label={t('Copy Homebrew command')}
                  >
                    {copied === 'homebrew' ? (
                      <CheckCheck size={15} aria-hidden="true" />
                    ) : (
                      <Copy size={15} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
            )}
            <div className={styles.releaseLinks}>
              <a href={release.url}>
                {t('Release notes')}
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
              <a href={release.checksumsUrl}>
                {t('All checksums')}
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
              <a href={release.manifestUrl}>
                {t('Package manifest')}
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
            </div>
          </>
        ) : (
          <div className={styles.noRelease}>
            <span className={styles.noReleaseIcon}>
              <ArrowDownToLine size={24} aria-hidden="true" />
            </span>
            <h3>
              {loading
                ? t('Looking for published installers.')
                : t('No verified installer is available here yet.')}
            </h3>
            <p>
              {t(
                'Installers appear after the release workflow publishes the packages and their checksums. Explore Kubepit now with the browser demo or the source code.',
              )}
            </p>
            <a href={`${repository}/releases`}>
              {t('Check releases on GitHub')}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </div>
        )}
        {copyFailed && (
          <p className={styles.copyFeedback} role="alert">
            {t('Copy was unavailable. Select the text and copy it manually.')}
          </p>
        )}
        <p className="sr-only" role="status">
          {copied ? t('Copied to clipboard.') : ''}
        </p>
      </div>
      <div className={styles.alternatives}>
        <span>{t('Prefer to explore first?')}</span>
        <a href={demo}>
          {t('Open the browser demo')}
          <ArrowUpRight size={13} aria-hidden="true" />
        </a>
        <a href={setup}>
          {t('Build from source')}
          <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
