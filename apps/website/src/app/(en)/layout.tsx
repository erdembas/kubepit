import type { ReactNode } from 'react';
import { LocaleProvider } from '@/i18n';
import { siteMetadata } from '@/lib/metadata';
import '../globals.css';

export const metadata = siteMetadata('en');
export default function EnglishLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LocaleProvider locale="en">{children}</LocaleProvider>
      </body>
    </html>
  );
}
