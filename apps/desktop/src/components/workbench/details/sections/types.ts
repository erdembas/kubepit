import type { ColumnContext } from '@/lib/kube/columns';
import type { Gvk, KubeObject } from '@/types';

export interface SectionProps {
  obj: KubeObject;
  gvk: Gvk;
  ctx: ColumnContext;
  isActive: boolean;
  readOnly: boolean;
}
