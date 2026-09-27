//! Kubeconfig client certificate insight (`cluster_client_certificate`).
//!
//! When a cluster's context authenticates with a client certificate
//! (inline `client-certificate-data` or a `client-certificate` file), the
//! UI warns before it expires. A tiny DER reader extracts the subject,
//! issuer and validity of the first certificate, which keeps the crate free
//! of X.509 dependencies. Nothing is verified, nothing touches the network
//! and the private key is never read.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use chrono::{NaiveDate, TimeZone, Utc};
use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};

use crate::app::Kubepit;
use crate::kubeconfig;

/// Mirrors `ClientCertificate` in `apps/desktop/src/types/index.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientCertificate {
    /// Subject common name (the Kubernetes user name).
    pub subject: String,
    /// Subject organizations (the Kubernetes groups), comma-separated.
    pub organization: String,
    /// Issuer common name.
    pub issuer: String,
    /// Epoch milliseconds.
    pub not_before: i64,
    pub not_after: i64,
    /// `inline` for `client-certificate-data`, otherwise the file path.
    pub source: String,
}

impl Kubepit {
    /// The client certificate of a cluster's kubeconfig user, `None` when it
    /// authenticates otherwise (token, exec plugin, OIDC…).
    pub fn cluster_client_certificate(&self, id: &str) -> Result<Option<ClientCertificate>> {
        let cluster = self.cluster_def(id)?;
        let kc = kubeconfig::load(Path::new(&cluster.kubeconfig_path))?;
        client_certificate(&kc, &cluster.context)
    }
}

/// Client certificate of `context`'s user; paths are already absolute
/// (`Kubeconfig::read_from` resolves them against the file's folder).
pub fn client_certificate(kc: &Kubeconfig, context: &str) -> Result<Option<ClientCertificate>> {
    kubeconfig::ensure_context(kc, context)?;
    let user = kc
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
        .and_then(|c| c.user.as_deref())
        .filter(|u| !u.is_empty());
    let Some(user) = user else { return Ok(None) };
    let Some(auth) = kc
        .auth_infos
        .iter()
        .find(|u| u.name == user)
        .and_then(|u| u.auth_info.as_ref())
    else {
        return Ok(None);
    };
    let (bytes, source) = if let Some(data) = auth
        .client_certificate_data
        .as_deref()
        .filter(|d| !d.trim().is_empty())
    {
        let compact: String = data.split_whitespace().collect();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(compact)
            .context("client-certificate-data is not valid base64")?;
        (bytes, "inline".to_string())
    } else if let Some(path) = auth
        .client_certificate
        .as_deref()
        .filter(|p| !p.trim().is_empty())
    {
        let bytes = std::fs::read(path)
            .with_context(|| format!("cannot read client certificate {path}"))?;
        (bytes, path.to_string())
    } else {
        return Ok(None);
    };
    let der = first_certificate(&bytes)?;
    let cert = parse_certificate(&der)?;
    Ok(Some(ClientCertificate { source, ..cert }))
}

/// The first `CERTIFICATE` block of PEM input, or the input itself when it is DER.
fn first_certificate(bytes: &[u8]) -> Result<Vec<u8>> {
    let text = String::from_utf8_lossy(bytes);
    let Some(begin) = text.find("-----BEGIN CERTIFICATE-----") else {
        if bytes.first() == Some(&0x30) {
            return Ok(bytes.to_vec());
        }
        bail!("the client certificate is neither PEM nor DER");
    };
    let body = &text[begin + "-----BEGIN CERTIFICATE-----".len()..];
    let end = body
        .find("-----END CERTIFICATE-----")
        .ok_or_else(|| anyhow!("unterminated PEM certificate"))?;
    let compact: String = body[..end].split_whitespace().collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact)
        .context("the PEM certificate is not valid base64")
}

// ---------------------------------------------------------------------------
// DER
// ---------------------------------------------------------------------------

struct Tlv<'a> {
    tag: u8,
    value: &'a [u8],
}

/// Reads one TLV and returns it with the remaining input.
fn read_tlv(input: &[u8]) -> Result<(Tlv<'_>, &[u8])> {
    let (&tag, rest) = input
        .split_first()
        .ok_or_else(|| anyhow!("truncated DER"))?;
    if tag & 0x1f == 0x1f {
        bail!("unsupported DER tag");
    }
    let (&first, mut rest) = rest.split_first().ok_or_else(|| anyhow!("truncated DER"))?;
    let len = if first & 0x80 == 0 {
        usize::from(first)
    } else {
        let n = usize::from(first & 0x7f);
        if n == 0 || n > 4 || rest.len() < n {
            bail!("unsupported DER length");
        }
        let (octets, tail) = rest.split_at(n);
        rest = tail;
        octets
            .iter()
            .fold(0usize, |acc, &b| (acc << 8) | usize::from(b))
    };
    if rest.len() < len {
        bail!("truncated DER");
    }
    let (value, rest) = rest.split_at(len);
    Ok((Tlv { tag, value }, rest))
}

fn children(value: &[u8]) -> Result<Vec<Tlv<'_>>> {
    let mut out = Vec::new();
    let mut rest = value;
    while !rest.is_empty() {
        let (tlv, tail) = read_tlv(rest)?;
        out.push(tlv);
        rest = tail;
    }
    Ok(out)
}

fn expect<'a>(tlv: Option<&Tlv<'a>>, tag: u8, what: &str) -> Result<&'a [u8]> {
    match tlv {
        Some(t) if t.tag == tag => Ok(t.value),
        _ => bail!("malformed certificate: expected {what}"),
    }
}

const OID_CN: &[u8] = &[0x55, 0x04, 0x03];
const OID_O: &[u8] = &[0x55, 0x04, 0x0a];

/// `(common name, organizations)` of an X.501 Name.
fn name(value: &[u8]) -> Result<(String, Vec<String>)> {
    let mut cn = String::new();
    let mut orgs = Vec::new();
    for set in children(value)? {
        for atv in children(set.value)? {
            let parts = children(atv.value)?;
            let (Some(oid), Some(val)) = (parts.first(), parts.get(1)) else {
                continue;
            };
            let text = String::from_utf8_lossy(val.value).into_owned();
            if oid.value == OID_CN && cn.is_empty() {
                cn = text;
            } else if oid.value == OID_O {
                orgs.push(text);
            }
        }
    }
    Ok((cn, orgs))
}

fn digits(s: &str, range: std::ops::Range<usize>) -> Result<u32> {
    s.get(range)
        .and_then(|d| d.parse().ok())
        .ok_or_else(|| anyhow!("malformed certificate time {s}"))
}

/// UTCTime (`YYMMDDHHMMSSZ`) or GeneralizedTime (`YYYYMMDDHHMMSSZ`) → epoch ms.
fn time(tlv: Option<&Tlv<'_>>) -> Result<i64> {
    let tlv = tlv.ok_or_else(|| anyhow!("malformed certificate: missing validity"))?;
    let s = std::str::from_utf8(tlv.value).context("malformed certificate time")?;
    let (year, rest) = match tlv.tag {
        0x17 => {
            let yy = digits(s, 0..2)?;
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, &s[2..])
        }
        0x18 => (digits(s, 0..4)?, s.get(4..).unwrap_or_default()),
        _ => bail!("malformed certificate: expected a time"),
    };
    let date = NaiveDate::from_ymd_opt(year as i32, digits(rest, 0..2)?, digits(rest, 2..4)?)
        .ok_or_else(|| anyhow!("malformed certificate date {s}"))?;
    let seconds = if rest.as_bytes().get(8).is_some_and(u8::is_ascii_digit) {
        digits(rest, 8..10)?
    } else {
        0
    };
    let at = date
        .and_hms_opt(digits(rest, 4..6)?, digits(rest, 6..8)?, seconds)
        .ok_or_else(|| anyhow!("malformed certificate time {s}"))?;
    Ok(Utc.from_utc_datetime(&at).timestamp_millis())
}

/// Subject, issuer and validity of a DER certificate (`source` left empty).
pub fn parse_certificate(der: &[u8]) -> Result<ClientCertificate> {
    let (cert, _) = read_tlv(der)?;
    let cert = children(expect(Some(&cert), 0x30, "a certificate")?)?;
    let tbs = children(expect(cert.first(), 0x30, "the TBS certificate")?)?;
    let mut fields = tbs.iter();
    let mut next = fields.next();
    if next.is_some_and(|t| t.tag == 0xa0) {
        next = fields.next(); // [0] EXPLICIT version
    }
    expect(next, 0x02, "the serial number")?;
    fields.next(); // signature algorithm
    let (issuer, _) = name(expect(fields.next(), 0x30, "the issuer")?)?;
    let validity = children(expect(fields.next(), 0x30, "the validity")?)?;
    let (subject, orgs) = name(expect(fields.next(), 0x30, "the subject")?)?;
    Ok(ClientCertificate {
        subject,
        organization: orgs.join(", "),
        issuer,
        not_before: time(validity.first())?,
        not_after: time(validity.get(1))?,
        source: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Throwaway certificate generated with openssl for these tests (key discarded).
    const CLIENT_PEM: &str = "-----BEGIN CERTIFICATE-----
MIICjDCCAXSgAwIBAgIUfNn85vuQ0tlQWrYZIIV5FLrIzxAwDQYJKoZIhvcNAQEL
BQAwNjEVMBMGA1UECgwMS3ViZXBpdCBEZW1vMR0wGwYDVQQDDBRLdWJlcGl0IERl
bW8gUm9vdCBDQTAeFw0yNjA5MjcxNzIwNDJaFw0yNjEwMTcxNzIwNDJaMDQxFzAV
BgNVBAoMDnN5c3RlbTptYXN0ZXJzMRkwFwYDVQQDDBBrdWJlcm5ldGVzLWFkbWlu
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEfAHMohLb4G8nyrzLHcSC06lm+2D/ILpc
alZtPe9Ih2ZjrEPt5WCTvjBmQT1vNwZXO3Ph9tlFxz9oNQsynA6aZatYebJSNcRd
DjN9NyKOUfLLWc6lRs87YolpvGqdHFaho0IwQDAdBgNVHQ4EFgQUj/esYE/y0lO2
8FjbAQ6TGekf3LcwHwYDVR0jBBgwFoAU4cCO6yjJlQJNbZ9HKnbZs/6GHXEwDQYJ
KoZIhvcNAQELBQADggEBAF3J08zciHfdVJ9ysgCg0SrmAtprfPNjbT3ygr6rGrib
onixBABP4iSCO38qmKy/ajp2dc0lPu6H3FtlP7cKUlttmwoE9MJFQ5zrZqnt+F8T
Jzi9hQeYjQAdKivQrDtJPoqyLErDV2bBRzelNuJ89Rzlu2locHmFjuMHivKo/Iie
NR1CJs/wo+zNh/CZzzDurJDrmI4j2PiU1JJKGP3X15BCODKuhxBJgI2rlt2OFn+3
fFIOeJv6Wu4OrUOIvKpD1pCJPYeBXKFvZYGOq3IpjLtEC3Q6UNrUZavV5RL5t8ct
mwCexBx4j5Gqn/RBf6xZiMYIeEJNhhRWblUKjr0iOUY=
-----END CERTIFICATE-----
";

    fn ms(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, s)
            .unwrap()
            .timestamp_millis()
    }

    fn kubeconfig(user: &str) -> String {
        format!(
            r#"
apiVersion: v1
kind: Config
current-context: admin
clusters:
- name: c
  cluster:
    server: https://127.0.0.1:6443
contexts:
- name: admin
  context:
    cluster: c
    user: {user}
users:
- name: inline
  user:
    client-certificate-data: {data}
    client-key-data: bm90LWEta2V5
- name: token
  user:
    token: abc
"#,
            data = base64::engine::general_purpose::STANDARD.encode(CLIENT_PEM)
        )
    }

    #[test]
    fn parses_subject_issuer_and_validity() {
        let der = first_certificate(CLIENT_PEM.as_bytes()).unwrap();
        let cert = parse_certificate(&der).unwrap();
        assert_eq!(cert.subject, "kubernetes-admin");
        assert_eq!(cert.organization, "system:masters");
        assert_eq!(cert.issuer, "Kubepit Demo Root CA");
        assert_eq!(cert.not_before, ms(2026, 9, 27, 17, 20, 42));
        assert_eq!(cert.not_after, ms(2026, 10, 17, 17, 20, 42));
        // DER input is accepted as-is.
        assert_eq!(first_certificate(&der).unwrap(), der);
    }

    #[test]
    fn reads_inline_certificate_data() {
        let kc = kubeconfig::load_text(&kubeconfig("inline")).unwrap();
        let cert = client_certificate(&kc, "admin").unwrap().unwrap();
        assert_eq!(cert.source, "inline");
        assert_eq!(cert.subject, "kubernetes-admin");
    }

    #[test]
    fn reads_certificate_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("client.crt");
        std::fs::write(&path, CLIENT_PEM).unwrap();
        let text = format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://127.0.0.1:6443\ncontexts:\n- name: admin\n  context:\n    cluster: c\n    user: file\nusers:\n- name: file\n  user:\n    client-certificate: {}\n",
            path.display()
        );
        let kc = kubeconfig::load_text(&text).unwrap();
        let cert = client_certificate(&kc, "admin").unwrap().unwrap();
        assert_eq!(cert.source, path.display().to_string());
        assert_eq!(cert.not_after, ms(2026, 10, 17, 17, 20, 42));
    }

    #[test]
    fn other_auth_methods_have_no_certificate() {
        let kc = kubeconfig::load_text(&kubeconfig("token")).unwrap();
        assert_eq!(client_certificate(&kc, "admin").unwrap(), None);
        assert!(client_certificate(&kc, "missing").is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(first_certificate(b"not a certificate").is_err());
        assert!(parse_certificate(&[0x30, 0x03, 0x02, 0x01, 0x01]).is_err());
        let truncated = &first_certificate(CLIENT_PEM.as_bytes()).unwrap()[..40];
        assert!(parse_certificate(truncated).is_err());
    }

    #[test]
    fn reads_generalized_time() {
        let tlv = Tlv {
            tag: 0x18,
            value: b"20510102030405Z",
        };
        assert_eq!(time(Some(&tlv)).unwrap(), ms(2051, 1, 2, 3, 4, 5));
        let utc = Tlv {
            tag: 0x17,
            value: b"991231235959Z",
        };
        assert_eq!(time(Some(&utc)).unwrap(), ms(1999, 12, 31, 23, 59, 59));
    }
}
