'use client';

import { useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Blocks,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Database,
  ExternalLink,
  FileDiff,
  GitBranch,
  Github,
  Globe2,
  Layers3,
  LockKeyhole,
  Menu,
  Network,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import * as i18n from '@/i18n';
import { KubepitMark } from '@/components/ui/KubepitMark';
import { asset, basePath, demo, repository } from '@/lib/links';

type FeatureGroup = 'all' | 'operate' | 'understand' | 'protect';

export function Site() {
  const { locale, t } = i18n.useLocale();
  const [menu, setMenu] = useState(false);
  const [workflow, setWorkflow] = useState(0);
  const [group, setGroup] = useState<FeatureGroup>('all');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const command =
    'git clone https://github.com/erdembas/kubepit.git\ncd kubepit\npnpm install\npnpm dev';
  const workflows = [
    {
      title: t('See the whole fleet'),
      label: t('01 / ORIENT'),
      icon: Layers3,
      heading: t('Less context switching. More context.'),
      body: t(
        'Group clusters by environment, watch fleet health, and find a resource across connected clusters. Keep the right context in view with split panes, pinned tabs and multiple windows.',
      ),
      detail: t('Fleet dashboard · Cross-cluster search · Drift comparison'),
      image: 'fleet.png',
      alt: t('Kubepit fleet dashboard showing fixture clusters and their health'),
    },
    {
      title: t('Follow the evidence'),
      label: t('02 / INVESTIGATE'),
      icon: Search,
      heading: t('From a symptom to the resource behind it.'),
      body: t(
        'Move from a workload to merged logs, events, metrics and its relationships. Inspect Argo CD and Flux resources, explore CRDs, and keep your terminal one keystroke away.',
      ),
      detail: t('Structured logs · Resource map · GitOps overview'),
      image: 'workbench.png',
      alt: t('Kubepit resource workbench with example Kubernetes workloads'),
    },
    {
      title: t('Review the change'),
      label: t('03 / ACT'),
      icon: FileDiff,
      heading: t('Know what changes before you apply it.'),
      body: t(
        'Use schema-aware YAML, server-side dry runs and object diffs. Preview Helm upgrades against the release or live resources, including fields Helm will remove. Review first, then decide.',
      ),
      detail: t('YAML validation · Helm upgrade preview · Change timeline'),
      image: 'workbench.png',
      alt: t('Kubepit resource workbench with example Kubernetes workloads'),
    },
  ];
  const features = [
    {
      group: 'operate',
      icon: Layers3,
      title: t('Your entire fleet'),
      text: t(
        'Sections, tags and environments. Live health, fleet search and cross-cluster resource comparison.',
      ),
      note: t('Works with your kubeconfigs'),
    },
    {
      group: 'operate',
      icon: Terminal,
      title: t('A real operator workspace'),
      text: t(
        'Merged pod logs, exec, attach, node shells, debug containers, file transfer and saved port forwards.',
      ),
      note: t('Shell features use kubectl'),
    },
    {
      group: 'operate',
      icon: Blocks,
      title: t('Helm, with the full picture'),
      text: t(
        'Browse charts, validate values, preview upgrades, inspect revision diffs and roll back releases.',
      ),
      note: t('Chart operations use Helm'),
    },
    {
      group: 'operate',
      icon: GitBranch,
      title: t('GitOps in the workbench'),
      text: t(
        'Discover Argo CD and Flux resources, follow ownership and inspect reconciliation in one place.',
      ),
      note: t('Uses installed GitOps CRDs'),
    },
    {
      group: 'understand',
      icon: Activity,
      title: t('Signals in context'),
      text: t(
        'Live metrics and local history, with Prometheus queries and Loki logs when those services are available.',
      ),
      note: t('Basic metrics need metrics-server'),
    },
    {
      group: 'understand',
      icon: Network,
      title: t('Relationships you can trace'),
      text: t(
        'Explore resource topology and explain standard NetworkPolicy decisions before chasing a connectivity issue.',
      ),
      note: t('Simulation is not a packet test'),
    },
    {
      group: 'understand',
      icon: Database,
      title: t('Cost with evidence'),
      text: t(
        'Inspect allocation estimates and right-sizing suggestions, with optional OpenCost or Kubecost data.',
      ),
      note: t('Estimates, not cloud invoices'),
    },
    {
      group: 'understand',
      icon: FileDiff,
      title: t('A memory for your cluster'),
      text: t(
        'Review observed changes, events and local action history. Compare revisions and prepare a reviewed revert.',
      ),
      note: t('Local history, not a cluster audit log'),
    },
    {
      group: 'protect',
      icon: ShieldCheck,
      title: t('Make risk visible'),
      text: t(
        'Inspect RBAC, Pod Security Standards, health and certificates. Read vulnerability reports from Trivy Operator.',
      ),
      note: t('Trivy reports need the operator'),
    },
    {
      group: 'protect',
      icon: ArrowUpRight,
      title: t('Prepare the next upgrade'),
      text: t(
        'Find deprecated APIs in resources and Helm manifests. Review blockers, replacements and scan coverage.',
      ),
      note: t('Coverage follows the bundled API table'),
    },
    {
      group: 'protect',
      icon: LockKeyhole,
      title: t('Deliberate changes'),
      text: t(
        'Built-in read-only guards, RBAC-aware actions, production confirmations and dry-run reviews.',
      ),
      note: t('Kubernetes RBAC is the security boundary'),
    },
    {
      group: 'protect',
      icon: Sparkles,
      title: t('AI on your terms'),
      text: t(
        'Opt in to your own provider, Ollama or supported local agents. Preview context and review suggested changes.',
      ),
      note: t('Remote providers receive approved context'),
    },
  ];
  const visible = features.filter(
    (f) =>
      (group === 'all' || f.group === group) &&
      `${f.title} ${f.text} ${f.note}`
        .toLocaleLowerCase(locale)
        .includes(query.toLocaleLowerCase(locale)),
  );
  const selected = workflows[workflow];
  const filters: { id: FeatureGroup; label: string }[] = [
    { id: 'all', label: t('Everything') },
    { id: 'operate', label: t('Operate') },
    { id: 'understand', label: t('Understand') },
    { id: 'protect', label: t('Protect') },
  ];
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <>
      <a className="skip-link" href="#main">
        {t('Skip to content')}
      </a>
      <header className="header">
        <div className="header-inner">
          <a
            href={`${basePath}/${locale === 'tr' ? 'tr/' : ''}`}
            className="brand"
            aria-label={t('Kubepit home')}
          >
            <KubepitMark />
            <span>kubepit</span>
            <span className="version">v0.0.1</span>
          </a>
          <nav
            className={menu ? 'navigation is-open' : 'navigation'}
            aria-label={t('Main navigation')}
          >
            <a href="#workflows" onClick={() => setMenu(false)}>
              {t('Experience')}
            </a>
            <a href="#features" onClick={() => setMenu(false)}>
              {t('Features')}
            </a>
            <a href="#principles" onClick={() => setMenu(false)}>
              {t('Open source')}
            </a>
            <a href="#start" onClick={() => setMenu(false)}>
              {t('Get started')}
            </a>
          </nav>
          <div className="header-actions">
            <a
              className="locale"
              href={`${basePath}/${locale === 'en' ? 'tr/' : ''}`}
              hrefLang={locale === 'en' ? 'tr' : 'en'}
              aria-label={t('Switch language')}
            >
              <Globe2 size={13} />
              {locale === 'en' ? 'TR' : 'EN'}
            </a>
            <a className="github-link" href={repository} aria-label="GitHub">
              <Github size={16} />
              <span>GitHub</span>
            </a>
            <button
              type="button"
              className="menu-button"
              aria-label={menu ? t('Close navigation') : t('Open navigation')}
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </header>
      <main id="main">
        <section className="hero container">
          <a className="release-pill" href={`${repository}/blob/main/CHANGELOG.md`}>
            <span className="release-dot" />
            {t('INTRODUCING 0.0.1')}
            <span className="pill-divider" />
            {t('An open-source beginning')}
            <ArrowUpRight size={13} />
          </a>
          <div className="hero-heading">
            <h1>
              {t('Your clusters.')}
              <br />
              <span>{t('Your cockpit.')}</span>
            </h1>
            <div className="hero-aside">
              <span className="eyebrow">{t('KUBERNETES, WITH CONTEXT')}</span>
              <p>
                {t(
                  'A local-first Kubernetes IDE for the people who keep things running. Your fleet, your tools, your next move — together.',
                )}
              </p>
              <div className="hero-buttons">
                <a className="button primary" href={demo}>
                  <Play size={14} fill="currentColor" />
                  {t('Explore the live demo')}
                </a>
                <a className="button secondary" href="#start">
                  <Code2 size={16} />
                  {t('Build from source')}
                </a>
              </div>
              <p className="hero-fine">{t('Free & MIT licensed. No account. No subscription.')}</p>
            </div>
          </div>
          <div className="product-window">
            <div className="window-bar">
              <div className="window-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <span>
                kubepit <span className="slash">/</span> {t('your Kubernetes workspace')}
              </span>
              <span className="sample-label">{t('DEMO DATA')}</span>
            </div>
            <a
              href={demo}
              className="product-image-link"
              aria-label={t('Open the interactive Kubepit demo')}
            >
              <img
                className="product-image"
                src={asset('workbench.png')}
                width="1600"
                height="1000"
                alt={t(
                  'Kubepit desktop workbench with fixture clusters, a resource table and details',
                )}
                fetchPriority="high"
              />
              <span className="image-cta">
                <Play size={14} fill="currentColor" />
                {t('Make yourself at home')}
              </span>
            </a>
          </div>
          <div className="hero-caption">
            <span>
              <Terminal size={13} />
              {t('A desktop app. A keyboard-first workflow.')}
            </span>
            <span>{t('Try the real UI in your browser. Only sample data.')}</span>
          </div>
        </section>
        <div className="trust-strip">
          <div className="trust-inner container">
            <span>{t('BUILT AROUND YOUR STACK')}</span>
            <span>Kubernetes</span>
            <span>Helm</span>
            <span>Argo CD</span>
            <span>Flux</span>
            <span>Prometheus</span>
            <span>Loki</span>
          </div>
        </div>
        <section className="section container" id="workflows">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t('ONE CONNECTED WORKFLOW')}</p>
              <h2>
                {t('From “what happened?”')}
                <br />
                <span className="muted">{t('to “here is the change.”')}</span>
              </h2>
            </div>
            <p className="section-intro">
              {t(
                'The tools you reach for during an incident, connected by the context you usually have to carry yourself.',
              )}
            </p>
          </div>
          <div className="workflow-tabs" role="tablist" aria-label={t('Explore workflows')}>
            {workflows.map((item, i) => (
              <button
                key={item.label}
                type="button"
                id={`workflow-tab-${i}`}
                role="tab"
                aria-selected={i === workflow}
                aria-controls="workflow-panel"
                tabIndex={i === workflow ? 0 : -1}
                onClick={() => setWorkflow(i)}
                onKeyDown={(e) => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                    e.preventDefault();
                    const next =
                      e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? 2
                          : (workflow + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
                    setWorkflow(next);
                    document.getElementById(`workflow-tab-${next}`)?.focus();
                  }
                }}
              >
                <span>{item.label}</span>
                <span>
                  <item.icon size={16} />
                  {item.title}
                </span>
              </button>
            ))}
          </div>
          <div
            id="workflow-panel"
            className="workflow-panel"
            role="tabpanel"
            aria-labelledby={`workflow-tab-${workflow}`}
            tabIndex={0}
          >
            <div className="workflow-copy">
              <selected.icon size={27} className="accent" />
              <h3>{selected.heading}</h3>
              <p>{selected.body}</p>
              <span className="workflow-detail">{selected.detail}</span>
              <a className="text-link" href={demo}>
                {t('Try this in the demo')}
                <ExternalLink size={13} />
              </a>
            </div>
            <div className="workflow-image">
              <img
                src={asset(selected.image)}
                alt={selected.alt}
                width="1600"
                height="1000"
                loading="lazy"
              />
            </div>
          </div>
        </section>
        <section className="section features-section" id="features">
          <div className="container">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{t('A DEEPER TOOLBOX')}</p>
                <h2>{t('Go beyond the resource list.')}</h2>
              </div>
              <p className="section-intro">
                {t(
                  'A broad set of operator workflows, built into one workbench. Explore what is available and what each integration needs.',
                )}
              </p>
            </div>
            <div className="feature-toolbar">
              <div className="feature-filters" aria-label={t('Filter features')}>
                {filters.map((f) => (
                  <button
                    type="button"
                    key={f.id}
                    aria-pressed={group === f.id}
                    className={group === f.id ? 'active' : ''}
                    onClick={() => setGroup(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <label className="feature-search">
                <Search size={14} />
                <span className="sr-only">{t('Search features')}</span>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('Find your workflow…')}
                />
              </label>
            </div>
            <div className="feature-grid" aria-live="polite">
              {visible.map((f) => (
                <article className="feature" key={f.title}>
                  <f.icon size={21} strokeWidth={1.5} />
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                  <span className="feature-note">{f.note}</span>
                </article>
              ))}
              {visible.length === 0 && (
                <p className="empty-results">
                  {t('No matching features. Try another search or category.')}
                </p>
              )}
            </div>
            <div className="keyboard-note">
              <span>
                <Terminal size={18} />
                {t('Mouse optional. Context essential.')}
              </span>
              <p>
                {t(
                  'Command palette, vim-style navigation, configurable shortcuts and support for importing compatible k9s plugins.',
                )}
              </p>
              <div aria-hidden="true">
                <kbd>⌘ K</kbd>
                <kbd>j</kbd>
                <kbd>k</kbd>
                <kbd>/</kbd>
              </div>
            </div>
          </div>
        </section>
        <section className="section principles container" id="principles">
          <div className="principles-heading">
            <p className="eyebrow">{t('LOCAL FIRST. OPEN BY DESIGN.')}</p>
            <h2>
              {t('Your infrastructure.')}
              <br />
              <span className="muted">{t('Your terms.')}</span>
            </h2>
            <p>
              {t(
                'Kubepit is a community project under the MIT license. The code is open, the workflow is yours, and there is no paid edition to unlock.',
              )}
            </p>
            <a className="text-link" href={`${repository}/blob/main/LICENSE`}>
              {t('Read the MIT license')}
              <ExternalLink size={13} />
            </a>
            <div className="license-stamp">
              <KubepitMark />
              <span>
                MIT<span>{t('FREE & OPEN SOURCE')}</span>
              </span>
            </div>
          </div>
          <div className="principles-list">
            <article>
              <span className="number">01</span>
              <div>
                <h3>{t('No account between you and your clusters.')}</h3>
                <p>
                  {t(
                    'Connect with your own kubeconfigs. State and observed history live locally. Imported configurations do not rewrite your originals.',
                  )}
                </p>
              </div>
            </article>
            <article>
              <span className="number">02</span>
              <div>
                <h3>{t('AI is a choice. Never a prerequisite.')}</h3>
                <p>
                  {t(
                    'Use Kubepit without AI, bring your own provider, or connect Ollama. Review the selected, redacted context before sending it. External providers can receive that content.',
                  )}
                </p>
              </div>
            </article>
            <article>
              <span className="number">03</span>
              <div>
                <h3>{t('Safeguards you can understand.')}</h3>
                <p>
                  {t(
                    'Read-only mode guards built-in mutations. Kubernetes RBAC remains the security boundary: terminals and custom commands can still use your credentials.',
                  )}
                </p>
              </div>
            </article>
            <article>
              <span className="number">04</span>
              <div>
                <h3>{t('A beginning you can help shape.')}</h3>
                <p>
                  {t(
                    '0.0.1 is an early community release. Expect rough edges, share reproducible issues, and help improve the workflows you use every day.',
                  )}
                </p>
              </div>
            </article>
          </div>
        </section>
        <section className="section compare-section">
          <div className="container">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{t('FIND YOUR WORKFLOW')}</p>
                <h2>
                  {t('Familiar territory.')}
                  <br />
                  <span className="muted">{t('A different point of view.')}</span>
                </h2>
              </div>
              <p className="section-intro">
                {t(
                  'Great Kubernetes tools take different paths. Choose the working environment that fits how you think.',
                )}
              </p>
            </div>
            <div className="compare-grid">
              <article>
                <span className="eyebrow">{t('THE DESKTOP ECOSYSTEM')}</span>
                <h3>Freelens</h3>
                <p>
                  {t(
                    'A community-maintained desktop IDE with an extension ecosystem. A natural fit if you want the familiar Lens-style experience and its extensions.',
                  )}
                </p>
                <a className="text-link" href="https://github.com/freelensapp/freelens">
                  {t('Explore Freelens')}
                  <ExternalLink size={12} />
                </a>
              </article>
              <article>
                <span className="eyebrow">{t('THE TERMINAL WORKFLOW')}</span>
                <h3>k9s</h3>
                <p>
                  {t(
                    'A terminal-centered Kubernetes interface with fast navigation, resource views and plugins. A natural fit when your terminal is your home base.',
                  )}
                </p>
                <a className="text-link" href="https://k9scli.io/">
                  {t('Explore k9s')}
                  <ExternalLink size={12} />
                </a>
              </article>
              <article className="kubepit-comparison">
                <span className="eyebrow">{t('THE CONNECTED WORKBENCH')}</span>
                <h3>
                  <KubepitMark />
                  Kubepit
                </h3>
                <p>
                  {t(
                    'A visual, local-first workspace that brings fleet context, investigation, reviewed changes and optional AI together — with keyboard-driven navigation built in.',
                  )}
                </p>
                <a className="text-link" href={demo}>
                  {t('Find your flow')}
                  <ExternalLink size={12} />
                </a>
              </article>
            </div>
            <p className="comparison-note">
              {t(
                'These are workflow differences, not an exhaustive feature ranking. Other tools also support extensions, integrations and safety controls.',
              )}
            </p>
          </div>
        </section>
        <section className="section getting-started container" id="start">
          <div>
            <p className="eyebrow">{t('START WITH CURIOSITY')}</p>
            <h2>{t('Take the controls.')}</h2>
            <p>
              {t(
                'Try the actual interface with fixture clusters, or build the desktop app and connect your own environment.',
              )}
            </p>
            <div className="start-options">
              <a href={demo}>
                <Play size={20} />
                <span>
                  <strong>{t('No-install browser demo')}</strong>
                  <span>{t('Sample data. No kubeconfig. No real cluster connection.')}</span>
                </span>
                <ExternalLink size={15} />
              </a>
              <a href={`${repository}/releases`}>
                <Code2 size={20} />
                <span>
                  <strong>{t('0.0.1 · source-first release')}</strong>
                  <span>{t('Check GitHub for release notes and available artifacts.')}</span>
                </span>
                <ExternalLink size={15} />
              </a>
            </div>
            <p className="platform-note">
              {t(
                'Desktop targets: macOS, Linux and Windows. Build prerequisites and validation vary by platform; signed installers and automatic updates are not promised for 0.0.1.',
              )}
            </p>
          </div>
          <div className="install-panel">
            <div className="code-header">
              <span>
                <Terminal size={14} />
                {t('BUILD LOCALLY')}
              </span>
              <button type="button" onClick={copy} aria-label={t('Copy installation commands')}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? t('Copied') : t('Copy')}
              </button>
            </div>
            <pre>
              <code>{command}</code>
            </pre>
            <div className="requirements">
              <span className="eyebrow">{t('BEFORE YOU START')}</span>
              <p>
                {t(
                  'Node.js 22+, pnpm 9, Rust 1.89+, Tauri platform dependencies and kubectl. Install Helm for chart operations.',
                )}
              </p>
              <a
                className="text-link"
                href={`${repository}/blob/main/${locale === 'tr' ? 'docs/README.tr.md' : 'README.md'}#${locale === 'tr' ? 'masaüstü-uygulamasını-çalıştırın' : 'run-the-desktop-app'}`}
              >
                {t('Read the setup guide')}
                <ExternalLink size={12} />
              </a>
            </div>
            <p className="sr-only" role="status">
              {copied ? t('Installation commands copied.') : ''}
            </p>
            {copyError && (
              <p className="copy-error" role="status">
                {t('Copy was unavailable. Select the commands above to copy them manually.')}
              </p>
            )}
          </div>
        </section>
        <section className="section faq-section container">
          <div>
            <p className="eyebrow">{t('THE USEFUL DETAILS')}</p>
            <h2>{t('Before you dive in.')}</h2>
          </div>
          <div className="faq-list">
            <details>
              <summary>
                {t('Is Kubepit really free?')}
                <ChevronDown size={16} />
              </summary>
              <p>
                {t(
                  'Yes. Kubepit is MIT licensed, with no subscription, activation server or paid feature tier. Optional third-party services, AI providers and your infrastructure may have their own costs.',
                )}
              </p>
            </details>
            <details>
              <summary>
                {t('What does the browser demo connect to?')}
                <ChevronDown size={16} />
              </summary>
              <p>
                {t(
                  'Only the in-memory mock backend shipped with the project. Clusters, logs, metrics and actions are simulated. It cannot connect to your clusters or execute real Kubernetes commands. Reloading resets backend changes; some interface preferences remain in your browser.',
                )}
              </p>
            </details>
            <details>
              <summary>
                {t('Does local-first mean completely offline?')}
                <ChevronDown size={16} />
              </summary>
              <p>
                {t(
                  'No. There is no Kubepit account or telemetry, but cluster access needs a network. Enabled integrations, AI providers, chart discovery and update checks can contact their configured services. The desktop UI also loads its font from Google Fonts.',
                )}
              </p>
            </details>
            <details>
              <summary>
                {t('What data stays on my machine?')}
                <ChevronDown size={16} />
              </summary>
              <p>
                {t(
                  'Settings, cluster definitions and observed history are stored under ~/.kubepit; interface preferences use local browser storage. History uses SQLite. Managed credentials use owner-only files or the optional OS keychain; subprocesses may need temporary kubeconfig files.',
                )}
              </p>
            </details>
            <details>
              <summary>
                {t('Do I need Prometheus, Loki or an AI subscription?')}
                <ChevronDown size={16} />
              </summary>
              <p>
                {t(
                  'No. Resource exploration uses the Kubernetes API. Basic usage metrics need metrics-server; historical Prometheus queries, Loki logs, cost providers and Trivy reports need their respective services. AI is optional, and Ollama can run locally.',
                )}
              </p>
            </details>
            <details>
              <summary>
                {t('Can I use 0.0.1 in production?')}
                <ChevronDown size={16} />
              </summary>
              <p>
                {t(
                  'This is an early release, not a production-readiness guarantee. Start with a development cluster and restricted RBAC. Built-in confirmations and previews help you review actions, but do not replace access control, backups or your operational judgment.',
                )}
              </p>
            </details>
            <details>
              <summary>
                {t('How can I contribute?')}
                <ChevronDown size={16} />
              </summary>
              <p>
                {t(
                  'Report a reproducible issue, improve a translation, test a platform or contribute code. Read the contribution guide first, use fixture data in tests and never include real kubeconfigs, tokens or sensitive logs in an issue.',
                )}
              </p>
              <a
                className="text-link"
                href={`${repository}/blob/main/CONTRIBUTING.md${locale === 'tr' ? '#türkçe' : ''}`}
              >
                {t('Contribution guide')}
                <ExternalLink size={12} />
              </a>
            </details>
          </div>
        </section>
        <section className="closing container">
          <div>
            <p className="eyebrow">{t('BUILT IN THE OPEN')}</p>
            <h2>{t('A better cockpit starts with us.')}</h2>
            <p>{t('Try it. Question it. Make it yours.')}</p>
          </div>
          <a className="button primary" href={repository}>
            <Github size={17} />
            {t('Join us on GitHub')}
          </a>
        </section>
      </main>
      <footer className="footer container">
        <a className="brand" href={`${basePath}/${locale === 'tr' ? 'tr/' : ''}`}>
          <KubepitMark />
          <span>kubepit</span>
        </a>
        <span>{t('Local-first Kubernetes IDE. MIT licensed.')}</span>
        <nav aria-label={t('Footer navigation')}>
          <a
            href={`${repository}/blob/main/${locale === 'tr' ? 'docs/README.tr.md' : 'README.md'}`}
          >
            {t('Documentation')}
          </a>
          <a href={`${repository}/blob/main/SECURITY.md${locale === 'tr' ? '#türkçe' : ''}`}>
            {t('Security')}
          </a>
          <a href={`${repository}/issues`}>{t('Issues')}</a>
          <a href="https://github.com/erdembas">Erdem Baş</a>
        </nav>
      </footer>
    </>
  );
}
