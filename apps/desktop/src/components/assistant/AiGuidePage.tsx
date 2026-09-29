import { useId, useRef, type ReactNode } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  MessageSquare,
  Settings2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import { useAppStore } from '@/store/useAppStore';
import { aiCapabilities } from './guideContent';

/** Available before setup; reading the guide never gathers or sends cluster context. */
export function AiGuidePage() {
  i18n.useLocale();
  const id = useId();
  const capabilities = useRef<HTMLElement>(null);
  const setup = useRef<HTMLElement>(null);
  const providers = useRef<HTMLElement>(null);
  const privacy = useRef<HTMLElement>(null);
  const openSettings = () => useAppStore.getState().openSettings('assistant');
  const sections = [
    { ref: capabilities, label: i18n.t('Capabilities') },
    { ref: setup, label: i18n.t('Getting started') },
    { ref: providers, label: i18n.t('Models and providers') },
    { ref: privacy, label: i18n.t('Data and control') },
  ];

  return (
    <div className="bg-surface @container flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="border-border/60 flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="bg-accent/10 text-accent flex h-6 w-6 items-center justify-center rounded-md">
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
        </span>
        <h1 className="text-fg text-[13px] font-semibold">{i18n.t('AI capabilities')}</h1>
        <Button
          size="sm"
          className="ml-auto"
          leftIcon={<Settings2 className="h-3.5 w-3.5" aria-hidden />}
          onClick={openSettings}
        >
          {i18n.t('Assistant settings')}
        </Button>
      </header>
      <nav
        aria-label={i18n.t('On this page')}
        className="border-border/60 flex shrink-0 flex-wrap gap-1 border-b px-4 py-1.5"
      >
        {sections.map(({ ref, label }) => (
          <Button
            key={label}
            variant="ghost"
            size="xs"
            onClick={() => {
              ref.current?.scrollIntoView({ block: 'start' });
              ref.current?.focus({ preventScroll: true });
            }}
          >
            {label}
          </Button>
        ))}
      </nav>
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto overscroll-contain">
        <div className="mx-auto w-full max-w-[1040px] space-y-8 px-5 py-6 @min-[720px]:px-8">
          <div className="flex items-start gap-3">
            <span className="bg-accent/10 text-accent flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 space-y-2">
              <h2 className="text-fg text-[13px] font-semibold">
                {i18n.t('Your Kubernetes questions, with context')}
              </h2>
              <p className="text-fg-muted max-w-[740px] text-[12px] leading-relaxed">
                {i18n.t(
                  'Investigate workloads, draft commands and queries, and improve manifests with the assistant. Use your own provider, a local model, or a supported installed agent.',
                )}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="-ml-2.5"
                rightIcon={<ArrowRight className="h-3.5 w-3.5" aria-hidden />}
                onClick={() => useAppStore.setState({ rightPanel: 'assistant' })}
              >
                {i18n.t('Open assistant')}
              </Button>
            </div>
          </div>

          <section
            ref={capabilities}
            tabIndex={-1}
            aria-labelledby={`${id}-capabilities`}
            className="scroll-mt-6 outline-none"
          >
            <SectionTitle id={`${id}-capabilities`}>{i18n.t('What you can do')}</SectionTitle>
            <div className="grid gap-3 @min-[680px]:grid-cols-2">
              {aiCapabilities().map(
                ({ id: key, icon: Icon, title, description, entry, example }) => (
                  <article
                    key={key}
                    className="border-border/70 bg-surface-raised flex min-w-0 flex-col rounded-lg border p-4"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <Icon className="text-accent h-4 w-4 shrink-0" aria-hidden />
                      <h3 className="text-fg text-[13px] font-medium">{title}</h3>
                    </div>
                    <p className="text-fg-muted text-[12px] leading-relaxed">{description}</p>
                    <p className="text-fg-dim mt-3 text-[11px] leading-relaxed">{entry}</p>
                    <div className="mt-auto pt-3">
                      <blockquote className="border-accent/50 bg-fg/3 text-fg-muted border-l-2 py-2 pr-2 pl-3 text-[12px] leading-relaxed">
                        <span className="text-fg-dim mb-1 block text-[11px] font-medium">
                          {i18n.t('Example prompt')}
                        </span>
                        {example}
                      </blockquote>
                    </div>
                  </article>
                ),
              )}
            </div>
            <div className="text-fg-muted mt-3 flex items-start gap-2 text-[12px] leading-relaxed">
              <MessageSquare className="text-fg-dim mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <p>
                {i18n.t(
                  'You can also ask general Kubernetes questions and continue with follow-ups. Choose the answer language independently of the app language in the composer.',
                )}
              </p>
            </div>
          </section>

          <section
            ref={setup}
            tabIndex={-1}
            aria-labelledby={`${id}-setup`}
            className="scroll-mt-6 outline-none"
          >
            <SectionTitle id={`${id}-setup`}>{i18n.t('Getting started')}</SectionTitle>
            <ol className="grid gap-4 @min-[680px]:grid-cols-3">
              <SetupStep number={1} title={i18n.t('Choose your model')}>
                {i18n.t(
                  'Open Assistant settings, enable the assistant, select a provider and model, then save. Use an API key for a hosted provider or your existing sign-in for an installed agent.',
                )}
              </SetupStep>
              <SetupStep number={2} title={i18n.t('Enable a cluster')}>
                {i18n.t(
                  'Allow assistant access for each cluster you want to use. Production clusters require you to type their name to confirm.',
                )}
              </SetupStep>
              <SetupStep number={3} title={i18n.t('Ask with the right context')}>
                {i18n.t(
                  'Open a workload, query or manifest and use its assistant action. Review the included context before sending, then continue the conversation in the assistant panel.',
                )}
              </SetupStep>
            </ol>
          </section>

          <section
            ref={providers}
            tabIndex={-1}
            aria-labelledby={`${id}-providers`}
            className="scroll-mt-6 outline-none"
          >
            <SectionTitle id={`${id}-providers`}>{i18n.t('Models and providers')}</SectionTitle>
            <div className="border-border/70 divide-border/60 divide-y rounded-lg border px-4">
              <ProviderRow title={i18n.t('Hosted providers')}>
                {i18n.t(
                  'Connect Anthropic or an OpenAI-compatible API with your own key. Provider API keys are stored in the operating system credential store.',
                )}
              </ProviderRow>
              <ProviderRow title={i18n.t('Local models')}>
                {i18n.t(
                  'Use Ollama or a compatible endpoint on this computer. Local-only mode blocks remote endpoints and installed agents.',
                )}
              </ProviderRow>
              <ProviderRow title={i18n.t('Installed agents')}>
                {i18n.t(
                  'Use Codex, Claude or OpenCode with their existing sign-in. These agents may use cloud services. They receive the redacted conversation; their shell, file access, MCP integrations and Kubernetes tools are disabled. Cursor can be detected but is not supported for chats.',
                )}
              </ProviderRow>
            </div>
          </section>

          <section
            ref={privacy}
            tabIndex={-1}
            aria-labelledby={`${id}-privacy`}
            className="scroll-mt-6 outline-none"
          >
            <SectionTitle
              id={`${id}-privacy`}
              icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
            >
              {i18n.t('Data and control')}
            </SectionTitle>
            <dl className="grid gap-x-6 gap-y-4 @min-[680px]:grid-cols-2">
              <ControlItem title={i18n.t('Preview shared context')}>
                {i18n.t(
                  'Inspect the redacted context, excluded sections and token estimate before sending. Messages without attached context can be sent directly to your selected provider.',
                )}
              </ControlItem>
              <ControlItem title={i18n.t('Sensitive values are masked')}>
                {i18n.t(
                  'Secret values, sensitive environment values and private keys are masked. Token masking is enabled by default; IP and hostname masking are optional. Review the preview before sharing.',
                )}
              </ControlItem>
              <ControlItem title={i18n.t('You approve changes')}>
                {i18n.t(
                  'The assistant can request read-only data with supported providers. By default, sharing tool results asks for consent. YAML changes use the existing review and permission checks; read-only clusters stay protected.',
                )}
              </ControlItem>
              <ControlItem title={i18n.t('History and usage')}>
                {i18n.t(
                  'Chats stay in this window’s memory. Optional request logging stores redacted requests and responses locally, with export and deletion in settings. Cost estimates require model prices you configure.',
                )}
              </ControlItem>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({
  id,
  icon,
  children,
}: {
  id: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <h2
      id={id}
      className="text-fg-dim mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-wider uppercase"
    >
      {icon}
      {children}
    </h2>
  );
}

function SetupStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2.5">
      <span
        className="bg-fg/5 text-fg-muted flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums"
        aria-hidden
      >
        {number}
      </span>
      <div>
        <h3 className="text-fg mb-1 text-[12px] font-medium">{title}</h3>
        <p className="text-fg-muted text-[12px] leading-relaxed">{children}</p>
      </div>
    </li>
  );
}

function ProviderRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 @min-[680px]:grid-cols-[140px_1fr] @min-[680px]:gap-4">
      <h3 className="text-fg text-[12px] font-medium">{title}</h3>
      <p className="text-fg-muted text-[12px] leading-relaxed">{children}</p>
    </div>
  );
}

function ControlItem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-fg mb-1 flex items-center gap-1.5 text-[12px] font-medium">
        <Check className="text-fg-dim h-3.5 w-3.5" aria-hidden />
        {title}
      </dt>
      <dd className="text-fg-muted pl-5 text-[12px] leading-relaxed">{children}</dd>
    </div>
  );
}
