import { describe, expect, it } from 'vitest';
import {
  kubeconfigExportCommand,
  kubeconfigOnDisk,
  posixQuote,
  powershellQuote,
} from './kubeconfigClipboard';

describe('posixQuote', () => {
  it('leaves plain paths alone', () => {
    expect(posixQuote('/Users/me/.kubepit/run/0b8f.kubeconfig')).toBe(
      '/Users/me/.kubepit/run/0b8f.kubeconfig',
    );
  });

  it('single-quotes spaces and shell metacharacters', () => {
    expect(posixQuote('/Users/me/My Files/$HOME;rm.yaml')).toBe(
      `'/Users/me/My Files/$HOME;rm.yaml'`,
    );
  });

  it('escapes single quotes', () => {
    expect(posixQuote(`/tmp/o'brien.yaml`)).toBe(`'/tmp/o'\\''brien.yaml'`);
  });

  it('keeps a leading ~/ expandable', () => {
    expect(posixQuote('~/.kubepit/run/a.kubeconfig')).toBe('~/.kubepit/run/a.kubeconfig');
    expect(posixQuote('~/my dir/a.yaml')).toBe(`~/'my dir/a.yaml'`);
  });
});

describe('powershellQuote', () => {
  it('doubles single quotes', () => {
    expect(powershellQuote(`C:\\Users\\o'brien\\a.kubeconfig`)).toBe(
      `'C:\\Users\\o''brien\\a.kubeconfig'`,
    );
  });
});

describe('kubeconfigExportCommand', () => {
  it('uses export on macOS and Linux', () => {
    expect(kubeconfigExportCommand('/k/run/a.kubeconfig', 'macos')).toBe(
      'export KUBECONFIG=/k/run/a.kubeconfig',
    );
    expect(kubeconfigExportCommand('/k/run dir/a', 'linux')).toBe(
      `export KUBECONFIG='/k/run dir/a'`,
    );
    expect(kubeconfigExportCommand('/k/a', null)).toBe('export KUBECONFIG=/k/a');
  });

  it('uses $env: on Windows', () => {
    expect(kubeconfigExportCommand('C:\\k\\run\\a.kubeconfig', 'windows')).toBe(
      `$env:KUBECONFIG = 'C:\\k\\run\\a.kubeconfig'`,
    );
  });
});

describe('kubeconfigOnDisk', () => {
  it('is false only for a managed copy in keychain mode', () => {
    expect(kubeconfigOnDisk({ managed: true }, false)).toBe(true);
    expect(kubeconfigOnDisk({ managed: true }, true)).toBe(false);
    expect(kubeconfigOnDisk({ managed: false }, true)).toBe(true);
  });
});
