import type { ReactNode } from 'react';
import { LocaleProvider } from '@/i18n';
import { siteMetadata } from '@/lib/metadata';
import '../../globals.css';

export const metadata = siteMetadata('tr');
export default function TurkishLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <LocaleProvider locale="tr">{children}</LocaleProvider>
      </body>
    </html>
  );
}
