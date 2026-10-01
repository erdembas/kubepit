import { Changelog } from '@/components/Changelog';
import { changelogMetadata } from '@/lib/metadata';

export const metadata = changelogMetadata('en');
export default function Page() {
  return <Changelog />;
}
