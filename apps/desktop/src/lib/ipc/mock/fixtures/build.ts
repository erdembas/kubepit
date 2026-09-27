import { buildArgo, buildCertManager, buildIngressNginx } from './addons';
import { buildCheckout, buildWeb } from './apps';
import { buildConfig } from './config';
import { buildCrds } from './crds';
import { buildData, buildLegacy, buildTeams } from './data';
import { setBuilder, type ClusterDb } from './db';
import { buildEvents } from './events';
import { buildHelm } from './helm';
import { buildClasses, buildLeaderLeases, buildNamespaces, buildWebhooks } from './infra';
import { buildMonitoring } from './monitoring';
import { buildIngress, buildNetworkPolicies } from './network';
import { buildNodes } from './nodes';
import { buildPolicies } from './policies';
import { buildRbac } from './rbac';
import { buildStorage } from './storage';
import { buildRolloutHistory } from './rollouts';
import { buildKubeSystem } from './system';

/** Builds one demo cluster. Order matters: later steps reference earlier objects. */
function buildCluster(db: ClusterDb) {
  buildNamespaces(db);
  buildNodes(db);
  buildClasses(db);
  buildWebhooks(db);
  buildLeaderLeases(db);
  buildKubeSystem(db);
  buildIngressNginx(db);
  buildCertManager(db);
  buildMonitoring(db);
  buildArgo(db);
  buildCheckout(db);
  buildWeb(db);
  buildData(db);
  buildLegacy(db);
  buildTeams(db);
  buildConfig(db);
  buildPolicies(db);
  buildNetworkPolicies(db);
  buildStorage(db);
  buildRbac(db);
  buildCrds(db);
  const domain = db.profile.domain;
  if (db.profile.platform !== 'kind')
    buildIngress(db, {
      namespace: 'monitoring',
      name: 'grafana',
      host: `grafana.${domain}`,
      tls: 'grafana-tls',
      paths: [['/', 'grafana', 80]],
    });
  if (db.profile.argocd)
    buildIngress(db, {
      namespace: 'argocd',
      name: 'argocd-server',
      host: `argocd.${domain}`,
      tls: 'argocd-server-tls',
      paths: [['/', 'argocd-server', 443]],
    });
  buildHelm(db);
  buildEvents(db);
  buildRolloutHistory(db);
}

setBuilder(buildCluster);
