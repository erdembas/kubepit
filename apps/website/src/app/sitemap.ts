import type { MetadataRoute } from 'next';
import { basePath, siteOrigin } from '@/lib/links';
export const dynamic = 'force-static';
export default function sitemap(): MetadataRoute.Sitemap {
  const en = `${siteOrigin}${basePath}/`;
  const tr = `${siteOrigin}${basePath}/tr/`;
  return ['', 'changelog/'].flatMap((path) =>
    [en, tr].map((root) => ({
      url: `${root}${path}`,
      alternates: { languages: { en: `${en}${path}`, tr: `${tr}${path}` } },
    })),
  );
}
