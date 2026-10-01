'use client';

import { Fragment } from 'react';
import { ArrowLeft, ArrowUpRight, Github, Globe2 } from 'lucide-react';
import * as i18n from '@/i18n';
import { KubepitMark } from '@/components/ui/KubepitMark';
import { basePath, repository } from '@/lib/links';
import { changelogBlocks, type ChangelogInline } from '@/lib/changelogMarkdown.mjs';
import { readReleaseSnapshot } from '@/lib/releases/model.mjs';
import snapshot from '@/lib/releases/snapshot.json';
import changelog from '../../../../shared/changelog/generated.json';
import styles from './Changelog.module.css';

const releases = readReleaseSnapshot(snapshot).releases;

function Inlines({ nodes }: { nodes: ChangelogInline[] }) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>;
      case 'code':
        return <code key={index}>{node.text}</code>;
      case 'strong':
        return (
          <strong key={index}>
            <Inlines nodes={node.children} />
          </strong>
        );
      case 'link':
        return (
          <a key={index} href={node.href}>
            <Inlines nodes={node.children} />
          </a>
        );
      case 'span':
        return (
          <Fragment key={index}>
            <Inlines nodes={node.children} />
          </Fragment>
        );
    }
  });
}

function Body({ source }: { source: string }) {
  return (
    <div className={styles.prose}>
      {changelogBlocks(source).map((block, index) => {
        switch (block.type) {
          case 'heading':
            return (
              <h3 key={index}>
                <Inlines nodes={block.children} />
              </h3>
            );
          case 'paragraph':
            return (
              <p key={index}>
                <Inlines nodes={block.children} />
              </p>
            );
          case 'list':
            return (
              <ul key={index}>
                {block.items.map((nodes, item) => (
                  <li key={item}>
                    <Inlines nodes={nodes} />
                  </li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}

export function Changelog() {
  const { locale, t } = i18n.useLocale();
  const home = `${basePath}/${locale === 'tr' ? 'tr/' : ''}`;
  const entries = changelog.entries;
  return (
    <>
      <a className="skip-link" href="#main">
        {t('Skip to content')}
      </a>
      <header className="header">
        <div className={`header-inner ${styles.header}`}>
          <a className="brand" href={home} aria-label={t('Kubepit home')}>
            <KubepitMark />
            <span>kubepit</span>
          </a>
          <nav className={styles.navigation} aria-label={t('Main navigation')}>
            <a href={`${home}#downloads`}>{t('Download Kubepit')}</a>
            <a
              className="locale"
              href={`${basePath}/${locale === 'en' ? 'tr/' : ''}changelog/`}
              hrefLang={locale === 'en' ? 'tr' : 'en'}
              aria-label={t('Switch language')}
            >
              <Globe2 size={13} />
              {locale === 'en' ? 'TR' : 'EN'}
            </a>
            <a className="github-link" href={repository} aria-label="GitHub">
              <Github size={16} />
              <span>GitHub</span>
            </a>
          </nav>
        </div>
      </header>
      <main id="main" className={`container ${styles.main}`}>
        <a className={styles.back} href={home}>
          <ArrowLeft size={13} />
          {t('Kubepit home')}
        </a>
        <div className={styles.intro}>
          <p className="eyebrow">{t('RELEASE NOTES')}</p>
          <h1>{t('Changelog')}</h1>
          <p>{t('New features, improvements and fixes, in one place.')}</p>
          <a className="text-link" href={`${repository}/blob/main/CHANGELOG.md`}>
            {t('Read on GitHub')}
            <ArrowUpRight size={13} />
          </a>
        </div>
        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <nav aria-label={t('Changelog versions')}>
              <p>{t('VERSIONS')}</p>
              {entries.map((entry) => (
                <a
                  key={entry.id}
                  href={`#${entry.id}`}
                  className={entry.status === 'unreleased' ? styles.nextLink : undefined}
                >
                  {entry.status === 'unreleased' ? t('Unreleased') : `v${entry.version}`}
                </a>
              ))}
            </nav>
            <a className={styles.downloadLink} href={`${home}#downloads`}>
              {t('Available downloads')}
              <ArrowUpRight size={12} />
            </a>
          </aside>
          <div className={styles.entries}>
            {entries.map((entry) => {
              const unreleased = entry.status === 'unreleased';
              const release = unreleased
                ? undefined
                : releases.find((item) => item.version === entry.version);
              const date = entry.date;
              return (
                <article
                  key={entry.id}
                  id={entry.id}
                  className={styles.entry}
                  aria-labelledby={`${entry.id}-title`}
                >
                  <div className={styles.entryMeta}>
                    <span className={unreleased ? styles.unreleasedBadge : styles.versionBadge}>
                      {unreleased ? t('Unreleased') : `v${entry.version}`}
                    </span>
                    {date && (
                      <time dateTime={date}>
                        {new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
                          dateStyle: 'medium',
                          timeZone: 'UTC',
                        }).format(new Date(date))}
                      </time>
                    )}
                    {release && (
                      <a href={release.url}>
                        {t('GitHub release')}
                        <ArrowUpRight size={12} />
                      </a>
                    )}
                  </div>
                  <h2 id={`${entry.id}-title`}>{entry.title[locale]}</h2>
                  {unreleased && (
                    <p className={styles.notice}>
                      {t(
                        'These changes are still in development and are not part of a published release.',
                      )}
                    </p>
                  )}
                  <Body source={entry.body[locale]} />
                </article>
              );
            })}
          </div>
        </div>
      </main>
      <footer className="footer container">
        <a className="brand" href={home}>
          <KubepitMark />
          <span>kubepit</span>
        </a>
        <span>{t('Local-first Kubernetes IDE. MIT licensed.')}</span>
        <nav aria-label={t('Footer navigation')}>
          <a href={`${home}#downloads`}>{t('Download Kubepit')}</a>
          <a
            href={`${repository}/blob/main/${locale === 'tr' ? 'docs/README.tr.md' : 'README.md'}`}
          >
            {t('Documentation')}
          </a>
          <a href={`${repository}/issues`}>{t('Issues')}</a>
        </nav>
      </footer>
    </>
  );
}
