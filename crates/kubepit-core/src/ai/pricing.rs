//! Prices are user supplied; an unknown model never has an invented cost.
use super::{AiPrice, AiUsage};

pub fn price_for<'a>(prices: &'a [AiPrice], model: &str) -> Option<&'a AiPrice> {
    prices.iter().find(|p| p.model == model)
}

pub fn cost(usage: &AiUsage, price: Option<&AiPrice>) -> Option<f64> {
    let p = price?;
    let total = (usage.input_tokens as f64 * p.input_per_mtok
        + usage.output_tokens as f64 * p.output_per_mtok
        + usage.cache_write_tokens as f64 * p.cache_write_per_mtok.unwrap_or(p.input_per_mtok)
        + usage.cache_read_tokens as f64 * p.cache_read_per_mtok.unwrap_or(p.input_per_mtok))
        / 1_000_000.0;
    (total.is_finite() && total >= 0.0).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn usage_cost_includes_cache_and_requires_a_price() {
        let usage = AiUsage {
            input_tokens: 1_000_000,
            output_tokens: 100_000,
            cache_read_tokens: 200_000,
            cache_write_tokens: 100_000,
        };
        assert_eq!(cost(&usage, None), None);
        let p = AiPrice {
            model: "test".into(),
            input_per_mtok: 5.,
            output_per_mtok: 25.,
            cache_write_per_mtok: Some(10.),
            cache_read_per_mtok: Some(1.),
        };
        assert_eq!(cost(&usage, Some(&p)), Some(8.7));
        assert!(price_for(&[p], "unknown").is_none());
    }
}
