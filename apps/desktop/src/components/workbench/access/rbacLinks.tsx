import * as i18n from '@/i18n';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import type { BindingInfo, RoleInfo, Subject } from '@/lib/kube/rbac';
import { groupHint, subjectKindLabel } from '@/lib/kube/rbac/titles';
import { navigateTo } from '@/store/useWorkbenchStore';

/** Links and labels shared by "who can", subject permissions and the RBAC details sections. */

export function openBinding(
  clusterId: string,
  b: Pick<BindingInfo, 'kind' | 'namespace' | 'name'>,
) {
  const def = b.kind === 'RoleBinding' ? BUILTIN.RoleBinding : BUILTIN.ClusterRoleBinding;
  navigateTo(clusterId, toGvk(def), b.namespace, b.name);
}

export function openRole(clusterId: string, r: Pick<RoleInfo, 'kind' | 'namespace' | 'name'>) {
  const def = r.kind === 'Role' ? BUILTIN.Role : BUILTIN.ClusterRole;
  navigateTo(clusterId, toGvk(def), r.namespace, r.name);
}

export function openServiceAccount(clusterId: string, s: Subject) {
  if (s.kind === 'ServiceAccount')
    navigateTo(clusterId, toGvk(BUILTIN.ServiceAccount), s.namespace, s.name);
}

export function LinkButton({
  onClick,
  children,
  title,
  mono = true,
}: {
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={
        mono
          ? 'text-accent hover:text-accent-hover min-w-0 truncate text-left font-mono text-[11px] hover:underline'
          : 'text-accent hover:text-accent-hover min-w-0 truncate text-left hover:underline'
      }
    >
      {children}
    </button>
  );
}

/** `binding → role` path with links to both. */
export function BindingPath({
  clusterId,
  binding,
  role,
}: {
  clusterId: string;
  binding: BindingInfo;
  role: Pick<RoleInfo, 'kind' | 'namespace' | 'name'> | null;
}) {
  i18n.useLocale();
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[11px]">
      <span className="text-fg-dim shrink-0 text-[10.5px]">{binding.kind}</span>
      <LinkButton
        onClick={() => openBinding(clusterId, binding)}
        title={`${binding.namespace ? `${binding.namespace}/` : ''}${binding.name}`}
      >
        {binding.namespace ? `${binding.namespace}/` : ''}
        {binding.name}
      </LinkButton>
      <span className="text-fg-dim">→</span>
      <span className="text-fg-dim shrink-0 text-[10.5px]">{binding.roleRef.kind}</span>
      {role ? (
        <LinkButton onClick={() => openRole(clusterId, role)}>{role.name}</LinkButton>
      ) : (
        <span className="text-status-error font-mono text-[11px]" title={i18n.t('Role not found')}>
          {binding.roleRef.name}
        </span>
      )}
    </span>
  );
}

/** Subject kind + name, with the meaning of built-in groups. */
export function SubjectLabel({
  clusterId,
  subject,
  className,
}: {
  clusterId: string;
  subject: Subject;
  className?: string;
}) {
  i18n.useLocale();
  const hint = subject.kind === 'Group' ? groupHint(subject.name) : null;
  return (
    <span className={className ?? 'min-w-0'}>
      <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
        <span className="text-fg-dim shrink-0 text-[10.5px]">{subjectKindLabel(subject.kind)}</span>
        {subject.kind === 'ServiceAccount' ? (
          <LinkButton mono={false} onClick={() => openServiceAccount(clusterId, subject)}>
            {subject.namespace}/{subject.name}
          </LinkButton>
        ) : (
          <span className="text-fg truncate" title={subject.name}>
            {subject.name}
          </span>
        )}
      </span>
      {hint && <span className="text-fg-dim block truncate text-[10.5px]">{hint}</span>}
    </span>
  );
}
