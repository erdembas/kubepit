//! Price models of cost estimates and validation of `ClusterDef.cost`.
//!
//! The platform defaults are rounded list prices of general-purpose
//! on-demand machines, split into a vCPU and a memory component (roughly
//! 1 vCPU ≈ 7.5 GiB-hours, the ratio OpenCost's defaults use): AWS `m6i`,
//! GCP `n2-standard`, Azure `Dsv5`, and a cheaper generic model for on-prem
//! and everything else. They are estimates by design: no discounts, no
//! spot, no control plane fees, no region. Clusters override them in the
//! cluster settings. Node-level pricing by instance type is deliberately
//! not attempted (it needs a price list per provider and region).

use anyhow::{bail, Result};

use super::types::{
    CostApiKind, CostConfig, CostPlatform, CostPricing, CostService, CostSourceConfig,
};
use super::HOURS_PER_MONTH;
use crate::prometheus::normalize_prefix;

impl CostPlatform {
    /// The platform whose prices apply to a detected distribution
    /// (`ClusterStatus.platform`).
    pub fn from_label(label: Option<&str>) -> Self {
        match label.map(str::to_ascii_lowercase).as_deref() {
            Some("eks") => CostPlatform::Eks,
            Some("gke") => CostPlatform::Gke,
            Some("aks") => CostPlatform::Aks,
            _ => CostPlatform::Generic,
        }
    }

    /// Default price model (USD).
    pub fn default_pricing(self) -> CostPricing {
        let (cpu_hour, memory_gib_hour, gpu_hour, storage_gib_month) = match self {
            // m6i.large: $0.096/h for 2 vCPU + 8 GiB; gp3 $0.08/GiB-month.
            CostPlatform::Eks => (0.0316, 0.0042, 0.95, 0.08),
            // n2-standard vCPU $0.031611/h, $0.004237/GiB-h; pd-balanced $0.10.
            CostPlatform::Gke => (0.0316, 0.0042, 0.95, 0.10),
            // D2s v5: $0.096/h for 2 vCPU + 8 GiB; Premium SSD v2 ≈ $0.10.
            CostPlatform::Aks => (0.0310, 0.0041, 0.90, 0.10),
            // Amortised on-prem hardware is cheaper per hour, but unknown.
            CostPlatform::Generic => (0.0240, 0.0030, 0.60, 0.05),
        };
        CostPricing {
            currency: "USD".to_string(),
            cpu_hour,
            memory_gib_hour,
            gpu_hour: Some(gpu_hour),
            storage_gib_month: Some(storage_gib_month),
            discount_percent: 0.0,
        }
    }
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
}

fn valid_price(value: f64) -> bool {
    value.is_finite() && (0.0..=1_000_000.0).contains(&value)
}

impl CostPricing {
    /// Trimmed and validated, as stored in `clusters.json`.
    pub fn normalized(self) -> Result<Self> {
        let currency = self.currency.trim().to_ascii_uppercase();
        if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_uppercase()) {
            bail!("Cost: the currency must be a three-letter ISO 4217 code such as USD or EUR");
        }
        if !valid_price(self.cpu_hour) || !valid_price(self.memory_gib_hour) {
            bail!("Cost: CPU and memory prices must be zero or positive numbers");
        }
        if self.gpu_hour.is_some_and(|p| !valid_price(p))
            || self.storage_gib_month.is_some_and(|p| !valid_price(p))
        {
            bail!("Cost: GPU and storage prices must be zero or positive numbers");
        }
        if !self.discount_percent.is_finite() || !(0.0..=100.0).contains(&self.discount_percent) {
            bail!("Cost: the discount must be between 0 and 100 percent");
        }
        Ok(Self { currency, ..self })
    }

    /// `1 − discount`.
    pub fn factor(&self) -> f64 {
        (1.0 - self.discount_percent / 100.0).clamp(0.0, 1.0)
    }

    /// Monthly cost of CPU cores (discount applied).
    pub fn cpu_monthly(&self, cores: f64) -> f64 {
        cores.max(0.0) * self.cpu_hour * HOURS_PER_MONTH * self.factor()
    }

    /// Monthly cost of memory bytes (discount applied).
    pub fn memory_monthly(&self, bytes: f64) -> f64 {
        bytes.max(0.0) / GIB * self.memory_gib_hour * HOURS_PER_MONTH * self.factor()
    }

    pub fn gpu_monthly(&self, gpus: f64) -> f64 {
        gpus.max(0.0) * self.gpu_hour.unwrap_or(0.0) * HOURS_PER_MONTH * self.factor()
    }

    /// Monthly cost of persistent volume bytes.
    pub fn storage_monthly(&self, bytes: f64) -> f64 {
        bytes.max(0.0) / GIB * self.storage_gib_month.unwrap_or(0.0) * self.factor()
    }
}

pub const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

fn service_parts(
    namespace: String,
    service: String,
    port: u16,
    path_prefix: &str,
) -> Result<(String, String, u16, String)> {
    let namespace = namespace.trim().to_string();
    let service = service.trim().to_string();
    if !valid_name(&namespace) {
        bail!("Cost: enter the namespace of the cost service");
    }
    if !valid_name(&service) {
        bail!("Cost: enter the name of the cost service");
    }
    if port == 0 {
        bail!("Cost: enter the port of the cost service");
    }
    Ok((namespace, service, port, normalize_prefix(path_prefix)?))
}

impl CostSourceConfig {
    /// The configured cost API (`opencost` / `kubecost` modes).
    pub fn service(&self) -> Option<CostService> {
        let (kind, namespace, service, port, scheme, path_prefix) = match self {
            CostSourceConfig::Opencost {
                namespace,
                service,
                port,
                scheme,
                path_prefix,
            } => (
                CostApiKind::Opencost,
                namespace,
                service,
                port,
                scheme,
                path_prefix,
            ),
            CostSourceConfig::Kubecost {
                namespace,
                service,
                port,
                scheme,
                path_prefix,
            } => (
                CostApiKind::Kubecost,
                namespace,
                service,
                port,
                scheme,
                path_prefix,
            ),
            _ => return None,
        };
        Some(CostService {
            kind,
            namespace: namespace.clone(),
            service: service.clone(),
            port: *port,
            scheme: *scheme,
            path_prefix: path_prefix.clone(),
        })
    }

    pub fn normalized(self) -> Result<Self> {
        Ok(match self {
            CostSourceConfig::Opencost {
                namespace,
                service,
                port,
                scheme,
                path_prefix,
            } => {
                let (namespace, service, port, path_prefix) =
                    service_parts(namespace, service, port, &path_prefix)?;
                CostSourceConfig::Opencost {
                    namespace,
                    service,
                    port,
                    scheme,
                    path_prefix,
                }
            }
            CostSourceConfig::Kubecost {
                namespace,
                service,
                port,
                scheme,
                path_prefix,
            } => {
                let (namespace, service, port, path_prefix) =
                    service_parts(namespace, service, port, &path_prefix)?;
                CostSourceConfig::Kubecost {
                    namespace,
                    service,
                    port,
                    scheme,
                    path_prefix,
                }
            }
            other => other,
        })
    }
}

impl CostConfig {
    /// Trimmed and validated, as stored in `clusters.json`.
    pub fn normalized(self) -> Result<Self> {
        Ok(Self {
            source: self.source.normalized()?,
            pricing: self.pricing.map(CostPricing::normalized).transpose()?,
        })
    }

    /// The price model of estimates: the cluster's own, else the platform's.
    pub fn effective_pricing(&self, platform: CostPlatform) -> (CostPricing, bool) {
        match &self.pricing {
            Some(pricing) => (pricing.clone(), true),
            None => (platform.default_pricing(), false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ClusterDef, PromScheme};

    #[test]
    fn platforms_map_to_price_models() {
        assert_eq!(CostPlatform::from_label(Some("EKS")), CostPlatform::Eks);
        assert_eq!(CostPlatform::from_label(Some("GKE")), CostPlatform::Gke);
        assert_eq!(CostPlatform::from_label(Some("AKS")), CostPlatform::Aks);
        assert_eq!(CostPlatform::from_label(Some("k3s")), CostPlatform::Generic);
        assert_eq!(CostPlatform::from_label(None), CostPlatform::Generic);
        for platform in [
            CostPlatform::Eks,
            CostPlatform::Gke,
            CostPlatform::Aks,
            CostPlatform::Generic,
        ] {
            let p = platform.default_pricing();
            assert_eq!(p.currency, "USD");
            // A 2 vCPU / 8 GiB machine costs between $0.05 and $0.12 an hour.
            let hourly = 2.0 * p.cpu_hour + 8.0 * p.memory_gib_hour;
            assert!((0.05..0.12).contains(&hourly), "{platform:?}: {hourly}");
            assert!(p.clone().normalized().is_ok());
        }
        assert!(
            CostPlatform::Generic.default_pricing().cpu_hour
                < CostPlatform::Eks.default_pricing().cpu_hour
        );
    }

    #[test]
    fn monthly_costs_apply_the_discount() {
        let pricing = CostPricing {
            currency: "EUR".into(),
            cpu_hour: 0.04,
            memory_gib_hour: 0.005,
            gpu_hour: None,
            storage_gib_month: Some(0.1),
            discount_percent: 25.0,
        };
        assert!((pricing.cpu_monthly(2.0) - 2.0 * 0.04 * 730.0 * 0.75).abs() < 1e-9);
        assert!((pricing.memory_monthly(4.0 * GIB) - 4.0 * 0.005 * 730.0 * 0.75).abs() < 1e-9);
        assert_eq!(pricing.gpu_monthly(1.0), 0.0, "GPUs are not priced");
        assert!((pricing.storage_monthly(100.0 * GIB) - 7.5).abs() < 1e-9);
        assert_eq!(pricing.cpu_monthly(-1.0), 0.0);
    }

    #[test]
    fn pricing_is_validated_and_the_currency_upper_cased() {
        let base = CostPricing {
            currency: " eur ".into(),
            cpu_hour: 0.03,
            memory_gib_hour: 0.004,
            gpu_hour: Some(1.0),
            storage_gib_month: None,
            discount_percent: 10.0,
        };
        assert_eq!(base.clone().normalized().unwrap().currency, "EUR");
        let bad_currency = CostPricing {
            currency: "euro".into(),
            ..base.clone()
        };
        assert!(bad_currency.normalized().is_err());
        let negative = CostPricing {
            cpu_hour: -0.1,
            ..base.clone()
        };
        assert!(negative.normalized().is_err());
        let nan = CostPricing {
            memory_gib_hour: f64::NAN,
            ..base.clone()
        };
        assert!(nan.normalized().is_err());
        let discount = CostPricing {
            discount_percent: 120.0,
            ..base
        };
        assert!(discount.normalized().is_err());
    }

    #[test]
    fn source_config_roundtrips_the_ts_union() {
        let auto: CostConfig = serde_json::from_str(r#"{"source":{"mode":"auto"}}"#).unwrap();
        assert_eq!(auto, CostConfig::default());
        let open: CostSourceConfig = serde_json::from_str(
            r#"{"mode":"opencost","namespace":" opencost ","service":"opencost","port":9003}"#,
        )
        .unwrap();
        let open = open.normalized().unwrap();
        let service = open.service().unwrap();
        assert_eq!(service.kind, CostApiKind::Opencost);
        assert_eq!(service.namespace, "opencost");
        assert_eq!(service.scheme, PromScheme::Http);
        assert_eq!(
            serde_json::to_value(CostSourceConfig::Estimate).unwrap(),
            serde_json::json!({"mode": "estimate"})
        );
        let bad = CostSourceConfig::Kubecost {
            namespace: "kubecost".into(),
            service: "Cost Analyzer".into(),
            port: 9090,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        assert!(bad.normalized().is_err());
        assert!(CostSourceConfig::Auto.service().is_none());
        // Older clusters.json files have no `cost` field.
        let def: ClusterDef = serde_json::from_value(serde_json::json!({
            "id": "c", "name": "c", "context": "x", "kubeconfig_path": "/k"
        }))
        .unwrap();
        assert_eq!(def.cost, CostConfig::default());
        let (pricing, custom) = def.cost.effective_pricing(CostPlatform::Gke);
        assert!(!custom);
        assert_eq!(pricing, CostPlatform::Gke.default_pricing());
    }
}
