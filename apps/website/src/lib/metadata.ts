import type { Metadata } from 'next';
import * as i18n from '@/i18n/core';
import { basePath, siteOrigin } from './links';

export function siteMetadata(locale: i18n.Locale): Metadata {
  const title = i18n.t('Kubepit — Your clusters. Your cockpit.', {}, locale);
  const description = i18n.t(
    'An open-source, local-first Kubernetes IDE. Explore your fleet, investigate workloads and review changes in one workspace. Free, MIT licensed, with a live browser demo.',
    {},
    locale,
  );
  const url = `${siteOrigin}${basePath}/${locale === 'tr' ? 'tr/' : ''}`;
  return {
    title,
    description,
    applicationName: 'Kubepit',
    metadataBase: new URL(siteOrigin),
    icons: { icon: `${basePath}/kubepit.svg` },
    alternates: {
      canonical: url,
      languages: {
        en: `${siteOrigin}${basePath}/`,
        tr: `${siteOrigin}${basePath}/tr/`,
        'x-default': `${siteOrigin}${basePath}/`,
      },
    },
    openGraph: {
      title,
      description,
      url,
      type: 'website',
      locale: locale === 'tr' ? 'tr_TR' : 'en_US',
      siteName: 'Kubepit',
    },
    twitter: { card: 'summary', title, description },
  };
}

export function changelogMetadata(locale: i18n.Locale): Metadata {
  const title = i18n.t('Changelog — Kubepit', {}, locale);
  const description = i18n.t('New features, improvements and fixes, in one place.', {}, locale);
  const languages = {
    en: `${siteOrigin}${basePath}/changelog/`,
    tr: `${siteOrigin}${basePath}/tr/changelog/`,
    'x-default': `${siteOrigin}${basePath}/changelog/`,
  };
  const url = languages[locale];
  return {
    title,
    description,
    alternates: { canonical: url, languages },
    openGraph: {
      title,
      description,
      url,
      type: 'website',
      locale: locale === 'tr' ? 'tr_TR' : 'en_US',
      siteName: 'Kubepit',
    },
    twitter: { card: 'summary', title, description },
  };
}
