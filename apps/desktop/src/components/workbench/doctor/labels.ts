import * as i18n from '@/i18n/core';
import type {
  ConnectionDoctorCapabilityId,
  ConnectionDoctorCode,
  ConnectionDoctorStage,
  ConnectionDoctorStatus,
} from '@/types/connectionDoctor';

export function stageLabel(stage: ConnectionDoctorStage): string {
  switch (stage) {
    case 'kubeconfig':
      return i18n.t('Kubeconfig and context');
    case 'auth-helper':
      return i18n.t('Authentication helper');
    case 'network':
      return i18n.t('DNS and network');
    case 'tls':
      return i18n.t('TLS certificate');
    case 'api':
      return i18n.t('Kubernetes API');
    case 'authentication':
      return i18n.t('Authenticated identity');
    case 'permissions':
      return i18n.t('Namespace permissions');
  }
}

export function statusLabel(status: ConnectionDoctorStatus): string {
  switch (status) {
    case 'passed':
      return i18n.t('Passed');
    case 'warning':
      return i18n.t('Needs attention');
    case 'failed':
      return i18n.t('Failed');
    case 'skipped':
      return i18n.t('Not checked');
  }
}

export function capabilityLabel(id: ConnectionDoctorCapabilityId): string {
  switch (id) {
    case 'namespaces':
      return i18n.t('List namespaces');
    case 'pods':
      return i18n.t('Browse pods');
    case 'watches':
      return i18n.t('Watch pod updates');
    case 'logs':
      return i18n.t('Read container logs');
    case 'metrics':
      return i18n.t('Read pod metrics');
    case 'helm':
      return i18n.t('Inspect Helm release secrets');
    case 'exec':
      return i18n.t('Open pod shells');
    case 'rollouts':
      return i18n.t('Change deployments');
  }
}

/** Fixed owned strings: raw server and authentication helper errors never cross IPC. */
export function codeLabel(code: ConnectionDoctorCode): string {
  switch (code) {
    case 'previous-step-failed':
      return i18n.t('A previous check must succeed before this step can run.');
    case 'namespace-invalid':
      return i18n.t(
        'Enter a valid Kubernetes namespace using lowercase letters, numbers and hyphens.',
      );
    case 'kubeconfig-invalid':
      return i18n.t(
        'The saved kubeconfig or context could not be loaded. Edit the cluster to repair or reimport its credentials.',
      );
    case 'kubeconfig-ready':
      return i18n.t('The saved kubeconfig and selected context are readable.');
    case 'legacy-auth-provider':
      return i18n.t(
        'This kubeconfig uses a legacy authentication provider. Refresh it with your provider CLI using exec authentication.',
      );
    case 'no-auth-helper':
      return i18n.t('This context does not require an external authentication helper.');
    case 'auth-helper-missing':
      return i18n.t(
        'The configured authentication program is missing or not executable. Install the provider helper and check the kubeconfig command.',
      );
    case 'auth-interactive':
      return i18n.t(
        'The authentication helper requires an interactive terminal. Sign in with your provider CLI, then retry.',
      );
    case 'auth-helper-failed':
      return i18n.t(
        'The authentication helper could not return valid credentials. Check your provider CLI installation and sign-in session.',
      );
    case 'auth-helper-timeout':
      return i18n.t(
        'The authentication helper exceeded its time limit. Sign in with your provider CLI, then retry.',
      );
    case 'auth-helper-ready':
      return i18n.t('The authentication helper returned usable credentials.');
    case 'auth-expired':
      return i18n.t(
        'The authentication helper returned expired credentials. Sign in again with your provider CLI.',
      );
    case 'endpoint-invalid':
      return i18n.t(
        'The API server or proxy address is invalid. Review the cluster connection settings.',
      );
    case 'network-timeout':
      return i18n.t('The endpoint did not respond in time. Check your VPN, proxy and firewall.');
    case 'dns-failed':
      return i18n.t(
        'The endpoint hostname could not be resolved. Check DNS, your VPN and the server address.',
      );
    case 'tcp-failed':
      return i18n.t(
        'The endpoint refused or could not accept a connection. Check that the cluster or proxy is running and reachable.',
      );
    case 'proxy-reachable':
      return i18n.t(
        'The proxy hostname resolves and its port is reachable. The API check verifies the full proxy route.',
      );
    case 'endpoint-reachable':
      return i18n.t('The API server hostname resolves and its port is reachable.');
    case 'tls-not-used':
      return i18n.t('This kubeconfig uses plain HTTP. TLS certificates are not checked.');
    case 'tls-unverified':
      return i18n.t(
        'Certificate verification is disabled in this kubeconfig. Enable verification with a trusted cluster CA.',
      );
    case 'tls-verified':
      return i18n.t(
        'The API response was received over TLS with certificate verification enabled.',
      );
    case 'tls-failed':
      return i18n.t(
        'TLS verification or negotiation failed. Check the cluster CA, certificate expiry and server name.',
      );
    case 'tls-unknown':
      return i18n.t('No API response was received, so TLS could not be verified.');
    case 'client-invalid':
      return i18n.t(
        'A Kubernetes client could not be created. Check certificates, keys and connection settings.',
      );
    case 'api-ready':
      return i18n.t('The Kubernetes version endpoint responded.');
    case 'api-timeout':
      return i18n.t(
        'The API request exceeded its time limit. Check the network route and API server health.',
      );
    case 'api-failed':
      return i18n.t('The API server returned an error. Check API server health and retry.');
    case 'api-unreachable':
      return i18n.t(
        'The full API request failed after the network check. Check the proxy route and connection settings.',
      );
    case 'unauthorized':
      return i18n.t(
        'The API server rejected the credentials. Refresh your sign-in session or reimport the kubeconfig.',
      );
    case 'forbidden':
      return i18n.t(
        'Access to the version endpoint is forbidden. The remaining checks test identity and namespace permissions separately.',
      );
    case 'anonymous':
      return i18n.t(
        'The API server sees this connection as anonymous. Check the user credentials in the kubeconfig.',
      );
    case 'identity-confirmed':
      return i18n.t('The API server confirmed an authenticated identity.');
    case 'identity-unavailable':
      return i18n.t(
        'The API server could not confirm identity through a self-review. The endpoint may be unsupported or forbidden; permissions are checked separately.',
      );
    case 'permissions-incomplete':
      return i18n.t(
        'Some access reviews could not be completed. Unknown results do not mean access is allowed.',
      );
    case 'permissions-limited':
      return i18n.t(
        'Some capabilities are restricted by Kubernetes RBAC or this cluster’s read-only setting.',
      );
    case 'permissions-ready':
      return i18n.t('The checked capabilities are allowed in this namespace.');
  }
}
