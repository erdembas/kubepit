'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUpRight,
  Box,
  Boxes,
  Check,
  Command,
  GitBranch,
  Github,
  Layers3,
  Pause,
  Play,
  Terminal,
} from 'lucide-react';
import * as i18n from '@/i18n';
import { KubepitMark } from '@/components/ui/KubepitMark';
import { asset, demo, repository } from '@/lib/links';
import { publishedRelease } from '@/lib/publishedRelease';
import styles from './Hero.module.css';

type HeroProps = {
  installHref?: string;
  demoHref?: string;
  releaseHref?: string;
};

/** Static-export friendly: motion enhances the actual product image, never gates it. */
export function Hero({
  installHref = '#start',
  demoHref = demo,
  releaseHref = `${repository}/blob/main/CHANGELOG.md`,
}: HeroProps) {
  const { t } = i18n.useLocale();
  const [paused, setPaused] = useState(false);
  const scene = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  function resetPointer() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    scene.current?.style.removeProperty('--tilt-x');
    scene.current?.style.removeProperty('--tilt-y');
    scene.current?.style.removeProperty('--light-x');
    scene.current?.style.removeProperty('--light-y');
  }

  function movePointer(event: PointerEvent<HTMLDivElement>) {
    if (
      paused ||
      event.pointerType !== 'mouse' ||
      !window.matchMedia('(prefers-reduced-motion: no-preference) and (min-width: 900px)').matches
    )
      return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      scene.current?.style.setProperty('--tilt-x', `${(0.5 - y) * 1.6}deg`);
      scene.current?.style.setProperty('--tilt-y', `${(x - 0.5) * 1.8}deg`);
      scene.current?.style.setProperty('--light-x', `${x * 100}%`);
      scene.current?.style.setProperty('--light-y', `${y * 100}%`);
      frame.current = null;
    });
  }

  return (
    <section
      className={styles.hero}
      aria-labelledby="hero-heading"
      data-motion={paused ? 'paused' : 'active'}
    >
      <div className={styles.ambient} aria-hidden="true">
        <div className={styles.grid} />
        <div className={styles.glow} />
        <div className={`${styles.orbit} ${styles.orbitOne}`} />
        <div className={`${styles.orbit} ${styles.orbitTwo}`} />
        <div className={styles.coordinates}>
          <span>+</span>
          <span>+</span>
          <span>+</span>
          <span>+</span>
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.intro}>
          <a className={styles.release} href={releaseHref}>
            <span className={styles.releaseDot} aria-hidden="true" />
            <span>
              {publishedRelease
                ? t('INTRODUCING {version}', { version: publishedRelease.version })
                : t('COMMUNITY EDITION')}
            </span>
            <span className={styles.releaseDivider} aria-hidden="true" />
            <span className={styles.releaseNote}>{t('An open-source beginning')}</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>

          <div className={styles.eyebrow}>
            <span aria-hidden="true" />
            {t('KUBERNETES, WITH CONTEXT')}
            <span aria-hidden="true" />
          </div>

          <h1 className={styles.heading} id="hero-heading">
            {t('Your clusters.')}
            <span className={styles.headingAccent}>
              <KubepitMark className={styles.headingMark} />
              {t('Your cockpit.')}
            </span>
          </h1>

          <p className={styles.description}>
            {t(
              'A local-first Kubernetes IDE for the people who keep things running. Your fleet, your tools, your next move — together.',
            )}
          </p>

          <div className={styles.actions}>
            <a className={styles.primary} href={installHref}>
              <ArrowDownToLine size={17} aria-hidden="true" />
              {t('Download Kubepit')}
              <ArrowUpRight size={15} className={styles.buttonArrow} aria-hidden="true" />
            </a>
            <a className={styles.secondary} href={demoHref}>
              <Play size={14} fill="currentColor" aria-hidden="true" />
              {t('Explore the live demo')}
            </a>
          </div>
          <p className={styles.fine}>
            <Check size={12} aria-hidden="true" />
            {t('Free & MIT licensed. No account. No subscription.')}
          </p>
        </div>

        <div
          className={styles.scene}
          ref={scene}
          onPointerMove={movePointer}
          onPointerLeave={resetPointer}
        >
          <div className={styles.sceneBackdrop} aria-hidden="true" />

          <div className={styles.sceneRoute} aria-hidden="true">
            <span>
              <Layers3 size={13} />
              {t('Your entire fleet')}
            </span>
            <i />
            <span className={styles.routeBrand}>
              <KubepitMark />
            </span>
            <i />
            <span>
              <GitBranch size={13} />
              {t('Review the change')}
            </span>
          </div>

          <div className={styles.productFrame}>
            <div className={styles.windowBar}>
              <div className={styles.windowDots} aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <span className={styles.windowTitle}>
                <KubepitMark />
                kubepit
                <span className={styles.slash} aria-hidden="true">
                  /
                </span>
                <span>{t('your Kubernetes workspace')}</span>
              </span>
              <span className={styles.sampleLabel}>
                <i aria-hidden="true" />
                {t('DEMO DATA')}
              </span>
            </div>
            <a
              href={demoHref}
              className={styles.productLink}
              aria-label={t('Open the interactive Kubepit demo')}
            >
              <img
                className={styles.productImage}
                src={asset('workbench.png')}
                width="1600"
                height="1000"
                alt={t(
                  'Kubepit desktop workbench with fixture clusters, a resource table and details',
                )}
                fetchPriority="high"
              />
              <span className={styles.productShade} aria-hidden="true" />
              <span className={styles.demoButton}>
                <span className={styles.demoPlay}>
                  <Play size={14} fill="currentColor" aria-hidden="true" />
                </span>
                <span>
                  {t('Make yourself at home')}
                  <span>{t('Explore the live demo')}</span>
                </span>
                <ArrowUpRight size={17} aria-hidden="true" />
              </span>
            </a>
          </div>

          <div className={`${styles.signalCard} ${styles.resourceCard}`} aria-hidden="true">
            <div className={styles.signalHeader}>
              <span className={styles.signalIcon}>
                <GitBranch size={14} />
              </span>
              <span>{t('Follow the evidence')}</span>
              <span className={styles.statusDot} />
            </div>
            <div className={styles.resourceTree}>
              <span>
                <Boxes size={14} />
                <span>
                  <small>Deployment</small>payment-api
                </span>
              </span>
              <i>
                <span />
              </i>
              <span>
                <Box size={14} />
                <span>
                  <small>Pod</small>payment-api-7c9d8b6f5
                </span>
              </span>
            </div>
            <div className={styles.signalFooter}>
              {t('Relationships you can trace')}
              <ArrowUpRight size={12} />
            </div>
          </div>

          <div className={`${styles.signalCard} ${styles.terminalCard}`} aria-hidden="true">
            <div className={styles.signalHeader}>
              <Terminal size={14} />
              <span>{t('Terminal preview')}</span>
              <span className={styles.terminalTag}>{t('DEMO DATA')}</span>
            </div>
            <div className={styles.terminalBody}>
              <span>
                <b>❯</b> kubectl get pods -n checkout
              </span>
              <span className={styles.terminalRow}>
                payment-api<span>Running</span>
              </span>
              <span className={styles.terminalRow}>
                payment-api<span>Running</span>
              </span>
              <span className={`${styles.terminalRow} ${styles.terminalWarning}`}>
                payment-api<span>CrashLoopBackOff</span>
              </span>
              <span className={styles.terminalPrompt}>
                <b>❯</b>
                <i />
              </span>
            </div>
          </div>
        </div>

        <div className={styles.caption}>
          <span className={styles.keyboard}>
            <Command size={13} aria-hidden="true" />
            {t('A desktop app. A keyboard-first workflow.')}
          </span>
          <span className={styles.sampleNote}>
            {t('Try the real UI in your browser. Only sample data.')}
          </span>
          <div className={styles.captionActions}>
            <a href={repository}>
              <Github size={13} aria-hidden="true" />
              {t('View source')}
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
            <button
              className={styles.motionToggle}
              type="button"
              aria-label={paused ? t('Resume motion') : t('Pause motion')}
              title={paused ? t('Resume motion') : t('Pause motion')}
              aria-pressed={paused}
              onClick={() => {
                resetPointer();
                setPaused(!paused);
              }}
            >
              {paused ? (
                <Play size={12} aria-hidden="true" />
              ) : (
                <Pause size={12} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
        <a className={styles.scrollLink} href="#workflows">
          <span>{t('Explore workflows')}</span>
          <ArrowDown size={13} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
