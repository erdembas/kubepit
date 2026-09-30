import * as i18n from '@/i18n/core';
import { basePath } from '@/lib/links';
import { KubepitMark } from '@/components/ui/KubepitMark';
import './globals.css';
export const metadata = { title: '404 · Kubepit', robots: { index: false, follow: false } };
export default function NotFound() {
  return (
    <html lang="en">
      <body>
        <main className="section container">
          <a className="brand" href={`${basePath}/`}>
            <KubepitMark />
            Kubepit
          </a>
          <h1 style={{ fontSize: 96, margin: '40px 0' }}>404</h1>
          <p>{i18n.t('Page not found.', {}, 'en')}</p>
          <p lang="tr">{i18n.t('Page not found.', {}, 'tr')}</p>
          <div className="hero-buttons">
            <a className="button primary" href={`${basePath}/`}>
              {i18n.t('Kubepit home', {}, 'en')}
            </a>
            <a className="button secondary" href={`${basePath}/tr/`} lang="tr">
              {i18n.t('Kubepit home', {}, 'tr')}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
