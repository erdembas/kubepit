import { buildArgo, buildCertManager, buildIngressNginx } from './addons';
import { buildCheckout, buildWeb } from './apps';
import { buildConfig } from './config';
import { buildCrds } from './crds';
import { buildData, buildLegacy, buildTeams } from './data';
import { put, setBuilder, type ClusterDb } from './db';
import { buildEvents } from './events';
import { buildGatewayApi } from './gateway';
import { buildHealthDemo } from './health';
import { buildGitOps } from './gitops';
import { buildHelm } from './helm';
import { buildClasses, buildLeaderLeases, buildNamespaces, buildWebhooks } from './infra';
import { buildLokiServices } from './loki';
import { buildMonitoring } from './monitoring';
import { buildIngress, buildNetworkPolicies } from './network';
import { buildNodes } from './nodes';
import { buildNetpolDemo } from './netpol';
import { buildPrometheusServices } from './prometheus';
import { buildCostServices } from './cost';
import { buildPolicies } from './policies';
import { buildRbac } from './rbac';
import { generateScaleObjects, scalePresetOf, type ScalePresetName } from './scale';
import { buildStorage } from './storage';
import { buildRolloutHistory } from './rollouts';
import { buildKubeSystem } from './system';
import { buildUpgradeDemo } from './upgrade';
import { buildSecurityDemo } from './security';

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
  buildPrometheusServices(db);
  buildLokiServices(db);
  buildCostServices(db);
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
  buildGatewayApi(db);
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
  buildHealthDemo(db);
  buildHelm(db);
  buildUpgradeDemo(db);
  buildGitOps(db);
  buildEvents(db);
  buildRolloutHistory(db);
  // Near the end, so the other fixtures keep their generated names.
  buildNetpolDemo(db);
  // Security: Pod Security labels, risky RBAC and Trivy reports (last: they cover everything).
  buildSecurityDemo(db);
}

/** A scaled demo cluster (`?scale=`): the generated objects only, no demo scenarios. */
function buildScaleCluster(db: ClusterDb, preset: ScalePresetName) {
  for (const o of generateScaleObjects(preset, db.id)) put(db, o);
}

setBuilder((db) => {
  const preset = scalePresetOf(db.id);
  if (preset) buildScaleCluster(db, preset);
  else buildCluster(db);
});
