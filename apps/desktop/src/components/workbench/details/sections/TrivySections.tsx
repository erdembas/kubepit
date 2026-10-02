import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { ChevronRight, ExternalLink, Lightbulb, Search, Sparkles } from 'lucide-react';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import { RefLink } from '@/lib/kube/columns/cells';
import { formatAge } from '@/lib/format';
import {
  SEVERITIES,
  checkCounts,
  complianceSummary,
  countVulns,
  exposedSecrets,
  osText,
  reportChecks,
  reportImage,
  reportTarget,
  safeLink,
  sbomSummary,
  scannerText,
  secretCounts,
  severityRank,
  updatedAt,
  vulnerabilities,
  type CheckResult,
  type SeverityCounts,
  type Vulnerability,
} from '@/lib/kube/trivy';
import { openExternal } from '../../actions/openExternal';
import { analyzeVulnerabilityRisk } from '../../actions/aiActions';
import { useAppStore } from '@/store/useAppStore';
import { SeverityText, SEV_TEXT, countOf, severityName } from '../../security/severity';
import { MonoText, Row, Rows, Section } from '../primitives';
import type { SectionProps } from './types';

/**
 * Details sections of Trivy Operator reports. Report data (CVE ids,
 * packages, check ids and titles) is shown verbatim; exposed-secret
 * reports show where a secret was found, never its value.
 */

const PAGE = 50;

function Counts({ counts, withUnknown }: { counts: SeverityCounts; withUnknown?: boolean }) {
  i18n.useLocale();
  const shown = withUnknown ? SEVERITIES : SEVERITIES.filter((s) => s !== 'UNKNOWN');
  return (
    <div className="grid grid-cols-2 gap-2 @xs:grid-cols-4">
      {shown.map((s) => {
        const n = countOf(counts, s);
        return (
          <div key={s} className="border-border/60 rounded-md border px-2.5 py-1.5">
            <span className="text-fg-dim block text-[10px] font-semibold tracking-[0.1em] uppercase">
              {severityName(s)}
            </span>
            <span
              className={cn(
                'text-[16px] font-semibold tabular-nums',
                n ? SEV_TEXT[s] : 'text-fg-dim/60',
              )}
            >
              {n}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ScannedObject({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const t = reportTarget(obj);
  const updated = updatedAt(obj);
  const image = reportImage(obj);
  return (
    <Rows>
      <Row label={i18n.t('Resource')}>
        {t.name ? (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-fg-dim text-[11px]">{t.kind}</span>
            <RefLink target={{ kind: t.kind, name: t.name, namespace: t.namespace }} ctx={ctx} />
          </span>
        ) : null}
      </Row>
      <Row label={i18n.t('Container')}>
        {t.container ? <MonoText>{t.container}</MonoText> : null}
      </Row>
      <Row label={i18n.t('Image')}>{image.text ? <MonoText>{image.text}</MonoText> : null}</Row>
      <Row label={i18n.t('Digest')}>
        {image.digest ? <MonoText>{image.digest}</MonoText> : null}
      </Row>
      <Row label={i18n.t('OS')}>{osText(obj) || null}</Row>
      <Row label={i18n.t('Scanner')}>{scannerText(obj) || null}</Row>
      <Row label={i18n.t('Updated')}>
        {updated ? (
          <span title={updated}>{i18n.t('{age} ago', { age: formatAge(updated, ctx.now) })}</span>
        ) : null}
      </Row>
    </Rows>
  );
}

function Filter({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="bg-surface border-border focus-within:border-accent/50 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border px-2">
      <Search className="text-fg-dim h-3 w-3 shrink-0" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[11.5px] outline-none"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vulnerabilities
// ---------------------------------------------------------------------------

function VulnRow({ v, onAsk }: { v: Vulnerability; onAsk: ((v: Vulnerability) => void) | null }) {
  i18n.useLocale();
  const link = safeLink(v.link);
  return (
    <li className="py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-fg truncate font-mono text-[11.5px] font-medium" lang="en">
          {v.id}
        </span>
        {link && (
          <button
            type="button"
            onClick={() => void openExternal(link)}
            title={i18n.t('Open advisory')}
            aria-label={i18n.t('Open advisory')}
            className="text-fg-dim hover:text-accent shrink-0"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
        {onAsk && (
          <button
            type="button"
            onClick={() => onAsk(v)}
            title={i18n.t('Analyze risk with assistant')}
            aria-label={i18n.t('Analyze risk with assistant')}
            className="text-fg-dim hover:text-accent shrink-0"
          >
            <Sparkles className="h-3 w-3" />
          </button>
        )}
        {v.score !== null && (
          <span className="text-fg-dim shrink-0 text-[10.5px] tabular-nums">{v.score}</span>
        )}
        <SeverityText severity={v.severity} className="ml-auto shrink-0 text-[11px]" />
      </div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-mono text-[10.5px]">
        <span className="text-fg-muted">{v.pkg}</span>
        <span className="text-fg-dim">{v.installed}</span>
        <span className="text-fg-dim">→</span>
        <span className={v.fixed ? 'text-status-running' : 'text-fg-dim'}>
          {v.fixed || i18n.t('no fix')}
        </span>
      </div>
      {v.title && (
        <p className="text-fg-dim mt-0.5 line-clamp-2 text-[11px]" title={v.title}>
          {v.title}
        </p>
      )}
    </li>
  );
}

export function VulnerabilityReportSections(props: SectionProps) {
  i18n.useLocale();
  const { obj, ctx } = props;
  const [query, setQuery] = useState('');
  const [fixableOnly, setFixableOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const aiEnabled = useAppStore((s) => s.settings?.ai.enabled) ?? false;
  const onAsk = aiEnabled
    ? (v: Vulnerability) =>
        void analyzeVulnerabilityRisk(ctx.clusterId, obj, v).catch((error) =>
          useAppStore.getState().pushToast('error', String(error)),
        )
    : null;
  const all = useMemo(
    () =>
      vulnerabilities(obj).sort(
        (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.id.localeCompare(b.id),
      ),
    [obj],
  );
  const q = query.trim().toLowerCase();
  const visible = all.filter(
    (v) =>
      (!fixableOnly || v.fixed) &&
      (!q ||
        v.id.toLowerCase().includes(q) ||
        v.pkg.toLowerCase().includes(q) ||
        v.title.toLowerCase().includes(q)),
  );
  return (
    <>
      <Section title={i18n.t('Scanned image')}>
        <ScannedObject {...props} />
      </Section>
      <Section title={i18n.t('Severity')} className="@container">
        <Counts counts={countVulns(all)} withUnknown />
        <p className="text-fg-dim mt-2 text-[11px]">
          {i18n.t('{count} of {total} have a fixed version', {
            count: all.filter((v) => v.fixed).length,
            total: all.length,
          })}
        </p>
      </Section>
      <Section title={i18n.t('Vulnerabilities')}>
        <div className="mb-2 flex items-center gap-3">
          <Filter
            value={query}
            onChange={setQuery}
            placeholder={i18n.t('Filter by CVE, package or title')}
          />
          <label className="text-fg-dim flex shrink-0 items-center gap-1.5 text-[11px]">
            <Switch checked={fixableOnly} onChange={setFixableOnly} bare />
            {i18n.t('Fixable only')}
          </label>
        </div>
        {!visible.length ? (
          <p className="text-fg-dim text-[12px]">
            {all.length
              ? i18n.t('Nothing matches the filter.')
              : i18n.t('No vulnerabilities found.')}
          </p>
        ) : (
          <>
            <ul className="divide-border/40 divide-y">
              {visible.slice(0, limit).map((v, i) => (
                <VulnRow key={`${v.id}|${v.pkg}|${v.installed}|${i}`} v={v} onAsk={onAsk} />
              ))}
            </ul>
            {visible.length > limit && (
              <button
                type="button"
                onClick={() => setLimit((n) => n + PAGE * 4)}
                className="text-accent mt-1 text-[11.5px] hover:underline"
              >
                {i18n.t('Show {count} more', { count: visible.length - limit })}
              </button>
            )}
          </>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Checks (config audit, RBAC and infra assessments)
// ---------------------------------------------------------------------------

function CheckRow({ c }: { c: CheckResult }) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="hover:bg-fg/3 flex w-full min-w-0 items-start gap-2 py-1.5 text-left"
      >
        <ChevronRight
          className={cn(
            'text-fg-dim mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-fg-dim shrink-0 font-mono text-[10.5px]" lang="en">
              {c.id}
            </span>
            <span
              className={cn(
                'min-w-0 truncate text-[12px]',
                c.success ? 'text-fg-muted' : 'text-fg',
              )}
            >
              {c.title}
            </span>
          </span>
          {!c.success && c.messages[0] && (
            <span className="text-fg-dim block text-[11px] break-words">{c.messages[0]}</span>
          )}
        </span>
        {c.success ? (
          <span className="text-status-running shrink-0 text-[11px]">{i18n.t('Passed')}</span>
        ) : (
          <SeverityText severity={c.severity} className="shrink-0 text-[11px]" />
        )}
      </button>
      {open && (
        <div className="space-y-1 pb-2 pl-5.5 text-[11.5px]">
          {c.description && <p className="text-fg-muted leading-relaxed">{c.description}</p>}
          {c.messages.slice(1).map((m) => (
            <p key={m} className="text-fg-dim break-words">
              {m}
            </p>
          ))}
          {c.remediation && (
            <p className="text-fg-muted flex items-start gap-1.5 leading-relaxed">
              <Lightbulb className="text-fg-dim mt-0.5 h-3 w-3 shrink-0" />
              <span>{c.remediation}</span>
            </p>
          )}
          {c.category && <p className="text-fg-dim text-[10.5px]">{c.category}</p>}
        </div>
      )}
    </li>
  );
}

export function CheckReportSections(props: SectionProps) {
  i18n.useLocale();
  const { obj } = props;
  const [showPassed, setShowPassed] = useState(false);
  const checks = useMemo(
    () =>
      reportChecks(obj).sort(
        (a, b) =>
          Number(a.success) - Number(b.success) ||
          severityRank(a.severity) - severityRank(b.severity) ||
          a.id.localeCompare(b.id),
      ),
    [obj],
  );
  const passed = checks.filter((c) => c.success).length;
  const visible = showPassed ? checks : checks.filter((c) => !c.success);
  return (
    <>
      <Section title={i18n.t('Scanned object')}>
        <ScannedObject {...props} />
      </Section>
      <Section title={i18n.t('Failed checks')} className="@container">
        <Counts counts={checkCounts(obj)} />
      </Section>
      <Section
        title={i18n.t('Checks')}
        actions={
          passed > 0 ? (
            <label className="text-fg-dim flex items-center gap-1.5 text-[11px] normal-case">
              <Switch checked={showPassed} onChange={setShowPassed} bare />
              {i18n.t('Show {count} passed', { count: passed })}
            </label>
          ) : undefined
        }
      >
        {!visible.length ? (
          <p className="text-fg-dim text-[12px]">
            {checks.length ? i18n.t('Every check passes.') : i18n.t('No checks in this report.')}
          </p>
        ) : (
          <ul className="divide-border/40 divide-y">
            {visible.map((c) => (
              <CheckRow key={c.id} c={c} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Exposed secrets
// ---------------------------------------------------------------------------

export function ExposedSecretReportSections(props: SectionProps) {
  i18n.useLocale();
  const { obj } = props;
  const secrets = useMemo(
    () => exposedSecrets(obj).sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    [obj],
  );
  return (
    <>
      <Section title={i18n.t('Scanned image')}>
        <ScannedObject {...props} />
      </Section>
      <Section title={i18n.t('Severity')} className="@container">
        <Counts counts={secretCounts(obj)} />
      </Section>
      <Section title={i18n.t('Exposed secrets')}>
        <p className="text-fg-dim mb-2 text-[11px]">
          {i18n.t('Only where a secret was found is shown; secret values are never displayed.')}
        </p>
        {!secrets.length ? (
          <p className="text-fg-dim text-[12px]">{i18n.t('No secrets found in this image.')}</p>
        ) : (
          <ul className="divide-border/40 divide-y">
            {secrets.map((s, i) => (
              <li key={`${s.ruleId}|${s.target}|${i}`} className="py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-fg min-w-0 truncate text-[12px]">
                    {s.title || s.ruleId}
                  </span>
                  <SeverityText severity={s.severity} className="ml-auto shrink-0 text-[11px]" />
                </div>
                <div className="text-fg-dim mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-[10.5px]">
                  <span className="text-fg-muted font-mono break-all">{s.target}</span>
                  <span className="font-mono" lang="en">
                    {s.ruleId}
                  </span>
                  {s.category && <span>{s.category}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export function ComplianceReportSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const c = useMemo(() => complianceSummary(obj), [obj]);
  const [onlyFailing, setOnlyFailing] = useState(true);
  const total = c.pass + c.fail;
  const controls = onlyFailing ? c.controls.filter((x) => (x.failed ?? 0) > 0) : c.controls;
  return (
    <>
      <Section title={i18n.t('Compliance')}>
        <Rows>
          <Row label={i18n.t('Standard')}>{c.title}</Row>
          <Row label={i18n.t('ID')}>
            <MonoText>{c.id}</MonoText>
          </Row>
          <Row label={i18n.t('Version')}>{c.version || null}</Row>
          <Row label={i18n.t('Schedule')}>
            {c.schedule ? <MonoText>{c.schedule}</MonoText> : null}
          </Row>
          <Row label={i18n.t('Updated')}>
            {c.updated ? (
              <span title={c.updated}>
                {i18n.t('{age} ago', { age: formatAge(c.updated, ctx.now) })}
              </span>
            ) : null}
          </Row>
        </Rows>
        {c.description && (
          <p className="text-fg-muted mt-2 text-[11.5px] leading-relaxed">{c.description}</p>
        )}
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[11.5px] tabular-nums">
            <span className="text-status-running">{i18n.t('{count} pass', { count: c.pass })}</span>
            <span className={c.fail ? 'text-status-error' : 'text-fg-dim'}>
              {i18n.t('{count} fail', { count: c.fail })}
            </span>
          </div>
          <span className="bg-fg/8 flex h-1.5 overflow-hidden rounded-full" aria-hidden>
            {total > 0 && (
              <>
                <span
                  className="bg-status-running"
                  style={{ width: `${(c.pass / total) * 100}%` }}
                />
                <span className="bg-status-error" style={{ width: `${(c.fail / total) * 100}%` }} />
              </>
            )}
          </span>
        </div>
      </Section>
      <Section
        title={i18n.t('Controls')}
        actions={
          <label className="text-fg-dim flex items-center gap-1.5 text-[11px] normal-case">
            <Switch checked={onlyFailing} onChange={setOnlyFailing} bare />
            {i18n.t('Failing only')}
          </label>
        }
      >
        {!controls.length ? (
          <p className="text-fg-dim text-[12px]">
            {c.controls.length
              ? i18n.t('Every control passes.')
              : i18n.t('No controls in this report.')}
          </p>
        ) : (
          <ul className="divide-border/40 divide-y">
            {controls.map((x) => (
              <li key={x.id} className="flex min-w-0 items-center gap-2 py-1 text-[11.5px]">
                <span className="text-fg-dim w-12 shrink-0 font-mono text-[10.5px]" lang="en">
                  {x.id}
                </span>
                <span className="text-fg min-w-0 flex-1 truncate" title={x.name}>
                  {x.name}
                </span>
                <SeverityText severity={x.severity} className="shrink-0 text-[10.5px]" />
                <span
                  className={cn(
                    'w-8 shrink-0 text-right tabular-nums',
                    x.failed ? 'text-status-error' : 'text-fg-dim',
                  )}
                >
                  {x.failed ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// SBOM
// ---------------------------------------------------------------------------

export function SbomReportSections(props: SectionProps) {
  i18n.useLocale();
  const { obj } = props;
  const sbom = useMemo(() => sbomSummary(obj), [obj]);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const q = query.trim().toLowerCase();
  const visible = q
    ? sbom.list.filter((c) => c.name.toLowerCase().includes(q) || c.purl.toLowerCase().includes(q))
    : sbom.list;
  return (
    <>
      <Section title={i18n.t('Scanned image')}>
        <ScannedObject {...props} />
      </Section>
      <Section title={i18n.t('Software bill of materials')}>
        <Rows>
          <Row label={i18n.t('Format')}>{sbom.format || null}</Row>
          <Row label={i18n.t('Components')}>{sbom.components}</Row>
          <Row label={i18n.t('Dependencies')}>{sbom.dependencies || null}</Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Components')}>
        <div className="mb-2 flex">
          <Filter value={query} onChange={setQuery} placeholder={i18n.t('Filter components')} />
        </div>
        {!visible.length ? (
          <p className="text-fg-dim text-[12px]">
            {sbom.list.length
              ? i18n.t('Nothing matches the filter.')
              : i18n.t('No components listed.')}
          </p>
        ) : (
          <>
            <ul className="divide-border/40 divide-y">
              {visible.slice(0, limit).map((c, i) => (
                <li
                  key={`${c.purl || c.name}|${i}`}
                  className="flex min-w-0 items-baseline gap-2 py-1 text-[11.5px]"
                >
                  <span
                    className="text-fg min-w-0 truncate font-mono text-[11px]"
                    title={c.purl || c.name}
                  >
                    {c.name}
                  </span>
                  <span className="text-fg-dim shrink-0 font-mono text-[10.5px]">{c.version}</span>
                  <span className="text-fg-dim ml-auto shrink-0 truncate text-[10.5px]">
                    {c.licenses.join(', ') || c.type}
                  </span>
                </li>
              ))}
            </ul>
            {visible.length > limit && (
              <button
                type="button"
                onClick={() => setLimit((n) => n + PAGE * 4)}
                className="text-accent mt-1 text-[11.5px] hover:underline"
              >
                {i18n.t('Show {count} more', { count: visible.length - limit })}
              </button>
            )}
          </>
        )}
      </Section>
    </>
  );
}
