import type { ClientCertificate } from '@/types';
import { BOOT, DAY } from './fixtures/util';
import { register, type MockArgs } from './registry';

/**
 * Demo client certificates: kubeadm-style admin certificates on the local
 * clusters (one close to its yearly rotation); the cloud clusters
 * authenticate with exec plugins and have none.
 */
const CERTS: Record<string, { issuedDaysAgo: number; lifetimeDays: number; source: string }> = {
  'c-dev': { issuedDaysAgo: 356, lifetimeDays: 365, source: 'inline' },
  'c-kind': { issuedDaysAgo: 40, lifetimeDays: 365, source: 'inline' },
  'c-minikube': {
    issuedDaysAgo: 900,
    lifetimeDays: 1095,
    source: '~/.minikube/profiles/minikube/client.crt',
  },
};

register({
  cluster_client_certificate: ({ id }: MockArgs): ClientCertificate | null => {
    const cert = CERTS[String(id)];
    if (!cert) return null;
    const notBefore = BOOT - cert.issuedDaysAgo * DAY;
    return {
      subject: 'kubernetes-admin',
      organization: 'kubeadm:cluster-admins',
      issuer: String(id) === 'c-minikube' ? 'minikubeCA' : 'kubernetes',
      not_before: notBefore,
      not_after: notBefore + cert.lifetimeDays * DAY,
      source: cert.source,
    };
  },
});
