//! Kubernetes resource quantity parsing.
//!
//! Implements the `resource.Quantity` grammar:
//!
//! ```text
//! <quantity>        ::= <signedNumber><suffix>
//! <suffix>          ::= <binarySI> | <decimalExponent> | <decimalSI>
//! <binarySI>        ::= Ki | Mi | Gi | Ti | Pi | Ei
//! <decimalSI>       ::= n | u | m | "" | k | M | G | T | P | E
//! <decimalExponent> ::= "e" <signedNumber> | "E" <signedNumber>
//! ```
//!
//! plus the non-canonical `K` that some tools emit. Metrics report CPU in
//! nanocores (`12345678n`) and memory in `Ki`; specs use `500m`, `1`, `2Gi`,
//! `1e9`… All of them must sum correctly on the overview page.
//!
//! Scaling is done by multiplying or *dividing* by exact powers of ten
//! rather than multiplying by `1e-3`, so `100m` is exactly `100` millicores.

/// Unit multiplier attached to a parsed number.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Scale {
    /// `10^exp`
    Decimal(i32),
    /// `1024^power`
    Binary(i32),
}

fn split(input: &str) -> Option<(f64, Scale)> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    let mut end = 0;
    if matches!(bytes[0], b'+' | b'-') {
        end = 1;
    }
    let digits_start = end;
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
        end += 1;
    }
    if end == digits_start {
        return None;
    }
    let number: f64 = s[..end].parse().ok()?;
    let suffix = &s[end..];
    let scale = match suffix {
        "" => Scale::Decimal(0),
        "n" => Scale::Decimal(-9),
        "u" => Scale::Decimal(-6),
        "m" => Scale::Decimal(-3),
        "k" | "K" => Scale::Decimal(3),
        "M" => Scale::Decimal(6),
        "G" => Scale::Decimal(9),
        "T" => Scale::Decimal(12),
        "P" => Scale::Decimal(15),
        "E" => Scale::Decimal(18),
        "Ki" => Scale::Binary(1),
        "Mi" => Scale::Binary(2),
        "Gi" => Scale::Binary(3),
        "Ti" => Scale::Binary(4),
        "Pi" => Scale::Binary(5),
        "Ei" => Scale::Binary(6),
        _ => {
            // Decimal exponent: `e3`, `E-2`, `e+6`. A bare `E` is exa (above).
            let rest = suffix.strip_prefix(['e', 'E'])?;
            if rest.is_empty() {
                return None;
            }
            let digits = rest.strip_prefix(['+', '-']).unwrap_or(rest);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Scale::Decimal(rest.parse::<i32>().ok()?)
        }
    };
    Some((number, scale))
}

fn apply(number: f64, scale: Scale, extra_decimal: i32) -> f64 {
    match scale {
        Scale::Decimal(exp) => {
            let exp = exp + extra_decimal;
            if exp >= 0 {
                number * 10f64.powi(exp)
            } else {
                number / 10f64.powi(-exp)
            }
        }
        Scale::Binary(power) => {
            let value = number * 1024f64.powi(power);
            if extra_decimal >= 0 {
                value * 10f64.powi(extra_decimal)
            } else {
                value / 10f64.powi(-extra_decimal)
            }
        }
    }
}

/// Parse a quantity into its base unit (cores, bytes, count).
pub fn parse_quantity(input: &str) -> Option<f64> {
    split(input).map(|(n, s)| apply(n, s, 0))
}

/// Parse a CPU quantity into millicores (`"250m"` → `250.0`, `"2"` → `2000.0`,
/// `"1500000n"` → `1.5`).
pub fn parse_cpu_millicores(input: &str) -> Option<f64> {
    split(input).map(|(n, s)| apply(n, s, 3))
}

/// Parse a memory quantity into bytes (`"1Ki"` → `1024.0`, `"1M"` → `1e6`).
pub fn parse_memory_bytes(input: &str) -> Option<f64> {
    parse_quantity(input)
}

/// Lenient helpers for summing: unparsable values count as zero.
pub fn cpu_or_zero(input: Option<&str>) -> f64 {
    input.and_then(parse_cpu_millicores).unwrap_or(0.0)
}

pub fn memory_or_zero(input: Option<&str>) -> f64 {
    input.and_then(parse_memory_bytes).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        let tol = 1e-9 * a.abs().max(b.abs()).max(1.0);
        (a - b).abs() <= tol
    }

    #[test]
    fn cpu_units() {
        assert_eq!(parse_cpu_millicores("100m"), Some(100.0));
        assert_eq!(parse_cpu_millicores("1"), Some(1000.0));
        assert_eq!(parse_cpu_millicores("2.5"), Some(2500.0));
        assert_eq!(parse_cpu_millicores("0.1"), Some(100.0));
        assert_eq!(parse_cpu_millicores("1500000n"), Some(1.5));
        assert_eq!(parse_cpu_millicores("250000000n"), Some(250.0));
        assert_eq!(parse_cpu_millicores("1500u"), Some(1.5));
        assert_eq!(parse_cpu_millicores("0"), Some(0.0));
        assert_eq!(parse_cpu_millicores(" 4 "), Some(4000.0));
        assert_eq!(parse_cpu_millicores("1k"), Some(1_000_000.0));
    }

    #[test]
    fn memory_binary_units() {
        assert_eq!(parse_memory_bytes("1Ki"), Some(1024.0));
        assert_eq!(parse_memory_bytes("128Mi"), Some(128.0 * 1024.0 * 1024.0));
        assert_eq!(parse_memory_bytes("2Gi"), Some(2.0 * 1024f64.powi(3)));
        assert_eq!(parse_memory_bytes("1Ti"), Some(1024f64.powi(4)));
        assert_eq!(parse_memory_bytes("1Pi"), Some(1024f64.powi(5)));
        assert_eq!(parse_memory_bytes("1Ei"), Some(1024f64.powi(6)));
        assert_eq!(parse_memory_bytes("1.5Gi"), Some(1.5 * 1024f64.powi(3)));
        assert_eq!(parse_memory_bytes("16323724Ki"), Some(16323724.0 * 1024.0));
    }

    #[test]
    fn memory_decimal_units() {
        assert_eq!(parse_memory_bytes("1k"), Some(1000.0));
        assert_eq!(parse_memory_bytes("1K"), Some(1000.0));
        assert_eq!(parse_memory_bytes("1M"), Some(1e6));
        assert_eq!(parse_memory_bytes("1G"), Some(1e9));
        assert_eq!(parse_memory_bytes("1T"), Some(1e12));
        assert_eq!(parse_memory_bytes("1P"), Some(1e15));
        assert_eq!(parse_memory_bytes("2E"), Some(2e18));
        assert_eq!(parse_memory_bytes("129e6"), Some(129e6));
        assert_eq!(parse_memory_bytes("123456789"), Some(123456789.0));
        assert_eq!(parse_memory_bytes("1500m"), Some(1.5));
    }

    #[test]
    fn exponent_notation() {
        assert_eq!(parse_quantity("1e3"), Some(1000.0));
        assert_eq!(parse_quantity("1E3"), Some(1000.0));
        assert_eq!(parse_quantity("1e+3"), Some(1000.0));
        assert!(close(parse_quantity("5e-3").unwrap(), 0.005));
        assert_eq!(parse_cpu_millicores("5e-3"), Some(5.0));
        assert!(close(parse_quantity("1.5e2").unwrap(), 150.0));
    }

    #[test]
    fn signs() {
        assert_eq!(parse_quantity("-1Ki"), Some(-1024.0));
        assert_eq!(parse_quantity("+5"), Some(5.0));
    }

    #[test]
    fn invalid_inputs() {
        for bad in [
            "", "   ", "abc", "Mi", "1Zi", "1.2.3", "1e", "1e+", "1ex", "--1", "1 Gi", "m",
        ] {
            assert_eq!(parse_quantity(bad), None, "{bad:?} should not parse");
        }
    }

    #[test]
    fn lenient_helpers() {
        assert_eq!(cpu_or_zero(Some("oops")), 0.0);
        assert_eq!(cpu_or_zero(None), 0.0);
        assert_eq!(memory_or_zero(Some("1Mi")), 1048576.0);
    }
}
