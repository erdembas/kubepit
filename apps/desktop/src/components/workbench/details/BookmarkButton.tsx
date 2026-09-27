import * as i18n from '@/i18n';
import { Bookmark, BookmarkCheck } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { sameObject, useBookmarksStore } from '@/store/useBookmarksStore';
import type { Gvk } from '@/types';
import { toggleObjectBookmark } from '../nav/bookmarkActions';

/** Details header toggle that bookmarks the shown object. */
export function BookmarkButton({
  clusterId,
  gvk,
  namespace,
  name,
}: {
  clusterId: string;
  gvk: Gvk;
  namespace: string | null;
  name: string;
}) {
  i18n.useLocale();
  const ns = gvk.namespaced ? namespace : null;
  const bookmarked = useBookmarksStore((s) =>
    s.bookmarks.some((b) => sameObject(b, clusterId, gvk, ns, name)),
  );
  return (
    <IconButton
      label={bookmarked ? i18n.t('Remove bookmark') : i18n.t('Bookmark')}
      aria-pressed={bookmarked}
      icon={bookmarked ? <BookmarkCheck className="text-accent" /> : <Bookmark />}
      onClick={() => toggleObjectBookmark(clusterId, gvk, ns, name)}
    />
  );
}
