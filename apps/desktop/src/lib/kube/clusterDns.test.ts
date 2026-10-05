import { describe, expect, it } from 'vitest';
import {
  clusterDnsSuffixes,
  parseCorefileClusterDomains,
  serviceDnsNames,
} from './clusterDns';

const COREFILE = `.:53 {
    errors
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
    }
    forward . /etc/resolv.conf
}
`;

describe('parseCorefileClusterDomains', () => {
  it('reads the standard cluster.local Corefile', () => {
    expect(parseCorefileClusterDomains(COREFILE)).toEqual(['cluster.local']);
  });

  it('keeps every non-reverse zone of a multi-zone kubernetes plugin', () => {
    const corefile = `.:53 {
    kubernetes cluster.local etraforsformation.cluster.local in-addr.arpa ip6.arpa {
       pods insecure
    }
}
`;
    expect(parseCorefileClusterDomains(corefile)).toEqual([
      'cluster.local',
      'etraforsformation.cluster.local',
    ]);
  });

  it('accepts a zone without a block and drops trailing dots', () => {
    const corefile = 'kubernetes a.local cluster.local.\nforward . /etc/resolv.conf\n';
    expect(parseCorefileClusterDomains(corefile)).toEqual(['a.local', 'cluster.local']);
  });

  it('uses the default zone for a bare kubernetes block', () => {
    expect(parseCorefileClusterDomains('kubernetes {\n  pods verified\n}\n')).toEqual([
      'cluster.local',
    ]);
  });

  it('deduplicates and ignores non-directive mentions', () => {
    const corefile = `.:53 {
    # kubernetes not-a-zone {
    rewrite name kubernetes.default.svc.cluster.local other.cluster.local
    kubernetes cluster.local cluster.local
}
`;
    expect(parseCorefileClusterDomains(corefile)).toEqual(['cluster.local']);
  });

  it('returns nothing without a kubernetes plugin', () => {
    expect(parseCorefileClusterDomains('forward . 8.8.8.8\n')).toEqual([]);
  });
});

describe('clusterDnsSuffixes', () => {
  it('falls back to cluster.local when there is no Corefile', () => {
    expect(clusterDnsSuffixes(null)).toEqual(['cluster.local']);
    expect(clusterDnsSuffixes('forward . 8.8.8.8\n')).toEqual(['cluster.local']);
  });

  it('keeps parsed zones', () => {
    expect(clusterDnsSuffixes('kubernetes a.local b.local {\n}\n')).toEqual([
      'a.local',
      'b.local',
    ]);
  });
});

describe('serviceDnsNames', () => {
  it('builds one FQDN per suffix', () => {
    expect(serviceDnsNames('api', 'checkout', ['cluster.local', 'a.local'])).toEqual([
      'api.checkout.svc.cluster.local',
      'api.checkout.svc.a.local',
    ]);
  });
});
