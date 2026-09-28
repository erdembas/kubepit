import * as i18n from '@/i18n/core';
import type { UpgradeFinding, UpgradeSource } from '@/types';
// The single source of truth, shared with the backend scanner (see the
// `_comment` in the file for how to update it).
import tableFile from '../../../../../crates/kubepit-core/src/upgrade/deprecated_apis.json';

/**
 * Deprecated and removed Kubernetes API versions: lookups for the
 * schema-aware editors and the Manifests tab, version arithmetic for the
 * upgrade readiness view, and the English/Turkish texts of the table's note
 * codes. apiVersions, kinds and versions themselves are never translated.
 */

export interface DeprecatedApi {
  api_version: string;
  kind: string;
  resource: string;
  deprecated_in: string;
  removed_in: string | null;
  replacement: string | null;
  replacement_kind?: string | null;
  notes: string[];
}

interface TableFile {
  updated: string;
  entries: DeprecatedApi[];
}

const TABLE = tableFile as unknown as TableFile;

export const DEPRECATED_APIS: readonly DeprecatedApi[] = TABLE.entries;
/** When the table was last reviewed (`YYYY-MM-DD`). */
export const DEPRECATIONS_UPDATED: string = TABLE.updated;

const BY_KEY = new Map(DEPRECATED_APIS.map((e) => [`${e.api_version}|${e.kind}`, e]));

/** The table entry for exactly this apiVersion + kind. */
export function deprecatedApi(apiVersion: string, kind: string): DeprecatedApi | null {
  return BY_KEY.get(`${apiVersion}|${kind}`) ?? null;
}

// -- Versions -------------------------------------------------------------------

/** `v1.31.4-eks-2d98532`, `1.31`, `1.31.0` → `[1, 31]`. */
export function parseMinor(version: string | null | undefined): [number, number] | null {
  const m = /^\s*v?(\d+)\.(\d+)/i.exec(version ?? '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** `1.31` of any version string, or null. */
export function minorOf(version: string | null | undefined): string | null {
  const parsed = parseMinor(version);
  return parsed ? `${parsed[0]}.${parsed[1]}` : null;
}

export function compareMinor(a: string, b: string): number {
  const x = parseMinor(a);
  const y = parseMinor(b);
  if (!x || !y) return 0;
  return x[0] - y[0] || x[1] - y[1];
}

/** The minor after `version` (`1.31.4` → `1.32`). */
export function nextMinor(version: string | null | undefined): string | null {
  const parsed = parseMinor(version);
  return parsed ? `${parsed[0]}.${parsed[1] + 1}` : null;
}

/** Targets the picker offers: the next few minors after the cluster's version. */
export function targetOptions(serverVersion: string | null | undefined, count = 4): string[] {
  const parsed = parseMinor(serverVersion);
  if (!parsed) return [];
  return Array.from({ length: count }, (_, i) => `${parsed[0]}.${parsed[1] + 1 + i}`);
}

// -- Texts ----------------------------------------------------------------------

function replacementText(entry: Pick<DeprecatedApi, 'replacement' | 'replacement_kind'>) {
  if (!entry.replacement) return null;
  return entry.replacement_kind
    ? `${entry.replacement} ${entry.replacement_kind}`
    : entry.replacement;
}

/** One sentence for editor markers and manifest rows. */
export function deprecationMessage(entry: DeprecatedApi): string {
  const values = {
    apiVersion: entry.api_version,
    kind: entry.kind,
    deprecated: entry.deprecated_in,
    removed: entry.removed_in ?? '',
    replacement: replacementText(entry) ?? '',
  };
  if (entry.removed_in)
    return entry.replacement
      ? i18n.t(
          '{apiVersion} {kind} is deprecated since Kubernetes {deprecated} and no longer served from {removed}. Use {replacement}.',
          values,
        )
      : i18n.t(
          '{apiVersion} {kind} is deprecated since Kubernetes {deprecated} and no longer served from {removed}. It has no replacement.',
          values,
        );
  return entry.replacement
    ? i18n.t(
        '{apiVersion} {kind} is deprecated since Kubernetes {deprecated}. Use {replacement}.',
        values,
      )
    : i18n.t('{apiVersion} {kind} is deprecated since Kubernetes {deprecated}.', values);
}

/** What a note code of the table (or a finding) means. */
export function noteText(
  code: string,
  finding?: Pick<UpgradeFinding, 'replacement'>,
): string | null {
  switch (code) {
    case 'selector_required':
      return i18n.t(
        'apps/v1 requires spec.selector, and the selector cannot change after creation.',
      );
    case 'psa':
      return i18n.t(
        'There is no replacement API: use Pod Security Admission or a policy engine instead.',
      );
    case 'webhook_defaults':
      return i18n.t(
        'v1 requires sideEffects and admissionReviewVersions, and failurePolicy defaults to Fail.',
      );
    case 'crd_structural':
      return i18n.t(
        'v1 requires a structural schema for every version; spec.validation and spec.version are gone.',
      );
    case 'sar_fields':
      return i18n.t('spec.group was renamed to spec.groups.');
    case 'csr_signer':
      return i18n.t('v1 requires spec.signerName, and the allowed usages depend on the signer.');
    case 'ingress_fields':
      return i18n.t(
        'Backends move to service.name and service.port, and every path needs a pathType.',
      );
    case 'endpointslice_topology':
      return i18n.t(
        'topology is replaced by zone and nodeName (deprecatedTopology keeps the rest).',
      );
    case 'event_fields':
      return i18n.t(
        'involvedObject becomes regarding, and the old count and timestamp fields get a deprecated prefix.',
      );
    case 'hpa_metrics':
      return i18n.t('Metric targets move to target.type and target.averageUtilization.');
    case 'pdb_selector':
      return i18n.t('In policy/v1 an empty selector matches every pod in the namespace.');
    case 'flowcontrol_shares':
      return i18n.t('assuredConcurrencyShares was renamed to nominalConcurrencyShares.');
    case 'endpoints_slices':
      return i18n.t(
        'Read and write EndpointSlices instead; the Endpoints API keeps working for now.',
      );
    case 'crd_deprecated_version':
      return i18n.t(
        'The CRD marks this version deprecated. Move clients and stored objects to {replacement}.',
        { replacement: finding?.replacement ?? '' },
      );
    case 'crd_only_deprecated':
      return i18n.t(
        'The CRD marks every served version deprecated; a newer release of its operator usually adds a successor.',
      );
    default:
      return null;
  }
}

export function sourceLabel(source: UpgradeSource): string {
  switch (source) {
    case 'last-applied':
      return i18n.t('Last applied configuration');
    case 'managed-fields':
      return i18n.t('Managed fields');
    case 'helm-release':
      return i18n.t('Helm release manifest');
    case 'crd':
      return i18n.t('Custom resource definition');
    case 'api-service':
      return i18n.t('Aggregated API service');
    case 'metrics':
      return i18n.t('API server metrics');
  }
}

/** Why this source matters, one sentence. */
export function sourceHint(source: UpgradeSource): string {
  switch (source) {
    case 'last-applied':
      return i18n.t(
        'The object was last applied with this apiVersion; the next kubectl apply from the same manifest fails once it is removed.',
      );
    case 'managed-fields':
      return i18n.t(
        'A client still writes the object through this apiVersion; it breaks once the version is removed.',
      );
    case 'helm-release':
      return i18n.t(
        "Helm rebuilds the objects of the release's stored manifest on every upgrade and rollback; a removed apiVersion there blocks both.",
      );
    case 'crd':
      return i18n.t('The CRD still serves versions it marks deprecated.');
    case 'api-service':
      return i18n.t('An extension API server registers an API version that Kubernetes removes.');
    case 'metrics':
      return i18n.t('Clients requested this API since the API server started.');
  }
}
