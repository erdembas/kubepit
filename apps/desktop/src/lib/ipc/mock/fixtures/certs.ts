import { BOOT, DAY } from './util';

/**
 * Real X.509 certificates for the demo backend, generated once with
 * `openssl` (throwaway keys, discarded; no private key ships here). Their
 * validity is re-stamped relative to the demo boot time so "expires in 12
 * days" stays true forever: the UTCTime fields keep their length, so the
 * DER stays well-formed (only the signature no longer verifies, which the
 * UI never checks).
 */

/** Cluster CA (`kube-root-ca.crt`), self-signed RSA 2048, 10 years. */
export const KUBE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIURxRkS/MVpzkoy9elLumvhZ3zysIwDQYJKoZIhvcNAQEL
BQAwFTETMBEGA1UEAwwKa3ViZXJuZXRlczAeFw0yNjA5MjcxNzM3MjhaFw0zNjA5
MjQxNzM3MjhaMBUxEzARBgNVBAMMCmt1YmVybmV0ZXMwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCM5key1n2eT5Vh1KUozbb4EhspIlnASN8oBw0Rrq5v
reseWllLJZG35LtDQpQQxN584CpLDlkYxRy9+gJEdxajkcaFYm7qyjCdpVE8EWLT
2sfiRGy/M6i+TUAxGSVnTxjd7fZKVtLVAbwK9dNvhLDVaK7BufcR/r8fISkKsLWx
drkuPWbKRUwZ4pgGB3W/ZbigQiPCmJVQbf5ZT0FYgGZEdBsW1tjjXTyNTRQmD/G3
YqUtdQi6sQmjxklUay5WnZBr8zPkdajJp31Ib2h4mHbkIYjVZiIguKeT6Cmgw93j
cO5g0g4LJIqFATBzkCkD7wgvsgOBOIYeevVtFCp4SuZtAgMBAAGjYzBhMB0GA1Ud
DgQWBBT4QuWCtgyJojkxQwM8Zkb/NYHGzDAfBgNVHSMEGDAWgBT4QuWCtgyJojkx
QwM8Zkb/NYHGzDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICpDANBgkq
hkiG9w0BAQsFAAOCAQEAW6ujq6ooqgVm0j65z0RMyagHTJaNtPaMP1yNh2xDDiyY
4QpjV6bJEI0ksMLNhBbJkJWMkAnVJG1obFPsqfCzCk6QSKbGMMOrCx247ApeeBEX
7cSCNP74UYjW6gwmYbaGvzvk0veGDHqsunpdG0Xb/fig+ARSkLdMj97QYMII0mUo
KoEUF9YhgKX7+gEojywssHx5INL4dWf2rTe2dWz1fkR4EEcDZcRaNQacuoPkRJVZ
kRKu647x3bMpS534HTk153HoUTjDBfC/ac7YIfBYkInqpRm5e69kEAkFEA/lET44
zRPXPDD4ZxBzjvXW4e53a4c+Ns0btEfy+NB8cJD7mw==
-----END CERTIFICATE-----
`;

/** Issuing CA of the demo TLS leaves, ECDSA P-256. */
export const DEMO_ISSUER_CA = `-----BEGIN CERTIFICATE-----
MIIB5zCCAY6gAwIBAgIUVEywUa19PPNz6zX7XZzJ25WZ31swCgYIKoZIzj0EAwIw
QDELMAkGA1UEBhMCVVMxEjAQBgNVBAoMCUFjbWUgRGVtbzEdMBsGA1UEAwwUQWNt
ZSBEZW1vIElzc3VpbmcgQ0EwHhcNMjYwOTI3MTczNzI4WhcNMzEwOTI2MTczNzI4
WjBAMQswCQYDVQQGEwJVUzESMBAGA1UECgwJQWNtZSBEZW1vMR0wGwYDVQQDDBRB
Y21lIERlbW8gSXNzdWluZyBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABFY8
c7HXLvjeoyItBUVtPdZngaqCZa2Epq1xcsVa1A4F1JTZYvqKuKHcXFWspYsQ5i28
XtYpWYJaugIsIhMsVO+jZjBkMB0GA1UdDgQWBBT0oWgpUEBBZIGfn+flMpBkPduz
LzAfBgNVHSMEGDAWgBT0oWgpUEBBZIGfn+flMpBkPduzLzASBgNVHRMBAf8ECDAG
AQH/AgEAMA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNHADBEAiB3QFF53lrH
XtmFzNj8b2tfM05LD6w/i1j+m7ENut3P+gIgKYBReC8YQcN9vcsKlhsn1ZTs0lU7
rapI9KhkFxofXqw=
-----END CERTIFICATE-----
`;

/** `shop.*` leaf, ECDSA P-256. */
export const STOREFRONT_LEAF = `-----BEGIN CERTIFICATE-----
MIICqDCCAk6gAwIBAgIUHo8Q0/6bNQ5sjqgH71EajJG/RW4wCgYIKoZIzj0EAwIw
QDELMAkGA1UEBhMCVVMxEjAQBgNVBAoMCUFjbWUgRGVtbzEdMBsGA1UEAwwUQWNt
ZSBEZW1vIElzc3VpbmcgQ0EwHhcNMjYwOTI3MTczNzI4WhcNMjYxMjI2MTczNzI4
WjAXMRUwEwYDVQQDDAxzaG9wLmFjbWUuZXUwWTATBgcqhkjOPQIBBggqhkjOPQMB
BwNCAAQJEox4k38n0ibdZFx8Gqk3RSUHYQygItHbbAa4X4AS/jGzdeXC8S+0hhJ4
C5xUrCsUYyO5sHMEH/c2YNwItIyyo4IBTTCCAUkwgdMGA1UdEQSByzCByIIMc2hv
cC5hY21lLmV1gg1zaG9wLmFjbWUuY29tghVzaG9wLnN0YWdpbmcuYWNtZS5kZXaC
EXNob3AuZGV2LmFjbWUuZGV2ghFzaG9wLmxvY2FsdGVzdC5tZYIQd3d3LnNob3Au
YWNtZS5ldYIRd3d3LnNob3AuYWNtZS5jb22CGXd3dy5zaG9wLnN0YWdpbmcuYWNt
ZS5kZXaCFXd3dy5zaG9wLmRldi5hY21lLmRldoIVd3d3LnNob3AubG9jYWx0ZXN0
Lm1lMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsG
AQUFBwMBMB0GA1UdDgQWBBSfm/NJi+6kbYpjwMw8byqLoQlIaTAfBgNVHSMEGDAW
gBT0oWgpUEBBZIGfn+flMpBkPduzLzAKBggqhkjOPQQDAgNIADBFAiEAiRKqf2bx
WgXL414yUrnhadrpwtMtj4Pd4skGqhs2K3ACIHPukZNjRW17bPLVTtXu2ZSqzu0Y
9ZO+Oycl3g4vioLH
-----END CERTIFICATE-----
`;

/** `grafana.*` leaf, ECDSA P-384. */
export const GRAFANA_LEAF = `-----BEGIN CERTIFICATE-----
MIICZDCCAgqgAwIBAgIUHo8Q0/6bNQ5sjqgH71EajJG/RW8wCgYIKoZIzj0EAwIw
QDELMAkGA1UEBhMCVVMxEjAQBgNVBAoMCUFjbWUgRGVtbzEdMBsGA1UEAwwUQWNt
ZSBEZW1vIElzc3VpbmcgQ0EwHhcNMjYwOTI3MTczNzI4WhcNMjYxMjI2MTczNzI4
WjAaMRgwFgYDVQQDDA9ncmFmYW5hLmFjbWUuZXUwdjAQBgcqhkjOPQIBBgUrgQQA
IgNiAAS4vm8NDtBgPWCAARwF0EYCE/Tnlcd+469HGBVUIX02fgvQeXrWZxXcNgUE
GbR6GQ32d+P7YfdQEytqHOLTBDFkTRjEYnJED0moFhsrJnPvuGp6TOPqUMxvKsw5
GnnxtdOjgeowgecwcgYDVR0RBGswaYIPZ3JhZmFuYS5hY21lLmV1ghBncmFmYW5h
LmFjbWUuY29tghhncmFmYW5hLnN0YWdpbmcuYWNtZS5kZXaCFGdyYWZhbmEuZGV2
LmFjbWUuZGV2ghRncmFmYW5hLmxvY2FsdGVzdC5tZTAMBgNVHRMBAf8EAjAAMA4G
A1UdDwEB/wQEAwIFoDATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQUQ7su
HeQ8fCowuWhpYme3kpAaUlcwHwYDVR0jBBgwFoAU9KFoKVBAQWSBn5/n5TKQZD3b
sy8wCgYIKoZIzj0EAwIDSAAwRQIhAIvz70f9ZpTaShWCyhfghCV5NlNxiVrpS/8+
HP6y16WHAiASrxAIMi7k3H1VSjZTyJ+l56v5iXGixDk11YmVcfI2Og==
-----END CERTIFICATE-----
`;

/** `legacy.*` leaf, RSA 2048. */
export const LEGACY_LEAF = `-----BEGIN CERTIFICATE-----
MIIDIjCCAsigAwIBAgIUHo8Q0/6bNQ5sjqgH71EajJG/RXAwCgYIKoZIzj0EAwIw
QDELMAkGA1UEBhMCVVMxEjAQBgNVBAoMCUFjbWUgRGVtbzEdMBsGA1UEAwwUQWNt
ZSBEZW1vIElzc3VpbmcgQ0EwHhcNMjYwOTI3MTczNzI4WhcNMjcwOTI3MTczNzI4
WjAvMRQwEgYDVQQKDAtBY21lIExlZ2FjeTEXMBUGA1UEAwwObGVnYWN5LmFjbWUu
ZXUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC662khX/thogikSFGQ
vqU0l/352cYhXNEQRfCM7b+gT124a+/KEiVsTqft8wyy8SXVNFrlD9iae4ppYIX6
iv7Gog/g1Hdv6uZrsLX3WdMY3Op4gUEb/IKvdBC3p64QqkEDp2XnVNio4WyBnhOM
8Hhp77iJS1R9XpNyc7eGnUCCv5TPRz32tRFdkvZyHpqtZz9qg4Zh+x7yCus8hxks
DiLTZ5Wc+fapcznJB+BgRF2S4l1eufGqWkEUoksU0aw2BW6zPPXxDwh9UyE+4xrn
SDMArnRbPI6eIqQatG3VtHo3Ipu52pl1Ik8WrAYxmAxJ/1OnKFwBg/1lQNEa5+Rk
12ybAgMBAAGjgeUwgeIwbQYDVR0RBGYwZIIObGVnYWN5LmFjbWUuZXWCD2xlZ2Fj
eS5hY21lLmNvbYIXbGVnYWN5LnN0YWdpbmcuYWNtZS5kZXaCE2xlZ2FjeS5kZXYu
YWNtZS5kZXaCE2xlZ2FjeS5sb2NhbHRlc3QubWUwDAYDVR0TAQH/BAIwADAOBgNV
HQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFB3LywyV
qRPczsBqxV/5nFAiChjKMB8GA1UdIwQYMBaAFPShaClQQEFkgZ+f5+UykGQ927Mv
MAoGCCqGSM49BAMCA0gAMEUCIDXc1io1oLC/Wv3BGmnHS7Fl5CxPJ1e80S5+qc99
2XnMAiEAodSCHrMNyrHD9J9qwsZLxPhsv38daNc549qhcDXf0ZA=
-----END CERTIFICATE-----
`;

/** cert-manager webhook CA, self-signed ECDSA P-256. */
export const WEBHOOK_CA = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUAa3JAsuJgKLLCCE8LE+O9Mxco8AwCgYIKoZIzj0EAwIw
IjEgMB4GA1UEAwwXY2VydC1tYW5hZ2VyLXdlYmhvb2stY2EwHhcNMjYwOTI3MTcz
NzI4WhcNMjcwOTI3MTczNzI4WjAiMSAwHgYDVQQDDBdjZXJ0LW1hbmFnZXItd2Vi
aG9vay1jYTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABOLv6c1MGsI8Hf9akfp9
TWRQN/esiM0ozSTLEnDUeGIKil3aI8QvI3zDk2lLImibl9B/CaBlXfHdwXsn7aN7
JyOjUzBRMB0GA1UdDgQWBBTs0ldXewhsdWUSLWSCssBHSIQtRDAfBgNVHSMEGDAW
gBTs0ldXewhsdWUSLWSCssBHSIQtRDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0gAMEUCIGHYJs5VYnNTIBr68LQNORBa9WEV/iNW/SsBZ+Oioln/AiEAiscX
+NO55GbJko3Eqcx1EYR3Bu2ivnky8DXS3JM8rec=
-----END CERTIFICATE-----
`;

/** ingress-nginx admission certificate, self-signed RSA 2048. */
export const ADMISSION_CA = `-----BEGIN CERTIFICATE-----
MIIDhDCCAmygAwIBAgIUL/uvC54uzsqPaC0Kbb3t+nIB5D8wDQYJKoZIhvcNAQEL
BQAwHjENMAsGA1UECgwEbmlsMTENMAsGA1UEAwwEbmlsMTAeFw0yNjA5MjcxNzM3
MjhaFw0zNjA5MjQxNzM3MjhaMB4xDTALBgNVBAoMBG5pbDExDTALBgNVBAMMBG5p
bDEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCjbWUPLx13W8ktLjAF
WEJvY2/hWhLedNIPQDeovpYzrfzSwl40BOrc30UzA83Tg1Lum8aVmOGw9iIBscWC
VUeJoyjnVZUqCcX68lU3Dzv0gdfhUAyptn1hofr5R7TJOQdDqIQ9dItBbGL+W6N+
flq3XzzW2mhNP6ujN6FWlIUcKeW+AzM6/9DnNpBxsqtxj7XyCjs0S9OL8oO9eNWX
3ebFiLhNw6HJlYUlG4rUJHoM4D9aP6Tvu1v1V9FsJcGVSXBpS5yU3WsidxYLw6Kx
blRc9PWzB7sRflb5xxhwyfDIKbW8zBoVaorgCFC2ilKDfrHEm4r2z8IypoXswEx0
xDNjAgMBAAGjgbkwgbYwHQYDVR0OBBYEFFrwhy171P/u7y1yrr7+xPkGPjX4MB8G
A1UdIwQYMBaAFFrwhy171P/u7y1yrr7+xPkGPjX4MGMGA1UdEQRcMFqCImluZ3Jl
c3MtbmdpbngtY29udHJvbGxlci1hZG1pc3Npb26CNGluZ3Jlc3MtbmdpbngtY29u
dHJvbGxlci1hZG1pc3Npb24uaW5ncmVzcy1uZ2lueC5zdmMwDwYDVR0TAQH/BAUw
AwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAIBCLSVTdvfupPKRQImDsp70kUbpaAH8S
DFghlTcLXidYG9smoBwCCzXXHz0TyYtadqwEzgmstPtnPwXf/VRVhdBOKMbD3OZz
VCnhaekMn+OAa0Tmlhpwhe+WYTouViCygnyEXT5ql3zZrf5okDdff87Zwamt+WUu
FC5s96Uc96pp1BUnUpwmehpzeGBRzV9WteZ1YJhJzJCkj4CJlQ6QlD/s3erZYccz
JtitJZ6kZKmHZt0GsDcTf5HSpxjHGLUxtPLYuwlH+ZP6ClsCHPYWPA5gAnPneurL
qLZIQV3Dz4PNY7LGvjnc3bxGmG0XC0wiS6Hrj1vp93auOwSOFQZOpQ==
-----END CERTIFICATE-----
`;

/** Placeholder key material: the demo never ships a real private key. */
export const DEMO_TLS_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDemoKeyOnly\n-----END PRIVATE KEY-----\n';

function utcTime(ms: number): number[] {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  const text =
    two(d.getUTCFullYear() % 100) +
    two(d.getUTCMonth() + 1) +
    two(d.getUTCDate()) +
    two(d.getUTCHours()) +
    two(d.getUTCMinutes()) +
    two(d.getUTCSeconds()) +
    'Z';
  return [...text].map((c) => c.charCodeAt(0));
}

/** Rewrites notBefore / notAfter (the first two UTCTime values) of every certificate in `pem`. */
export function restamp(pem: string, notBefore: number, notAfter: number): string {
  return pem.replace(
    /(-----BEGIN CERTIFICATE-----)([\s\S]*?)(-----END CERTIFICATE-----)/g,
    (_, begin: string, body: string, end: string) => {
      const der = Uint8Array.from(atob(body.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
      const stamps = [utcTime(notBefore), utcTime(notAfter)];
      let found = 0;
      for (let i = 0; i + 15 <= der.length && found < 2; i++) {
        // UTCTime tag, length 13, …, trailing 'Z'.
        if (der[i] !== 0x17 || der[i + 1] !== 0x0d || der[i + 14] !== 0x5a) continue;
        der.set(stamps[found++]!, i + 2);
        i += 14;
      }
      let binary = '';
      for (const b of der) binary += String.fromCharCode(b);
      const lines = btoa(binary).match(/.{1,64}/g) ?? [];
      return `${begin}\n${lines.join('\n')}\n${end}`;
    },
  );
}

/** `pem` valid from `issuedDaysAgo` days before the demo boot until `expiresInDays` after it. */
export function stamped(pem: string, issuedDaysAgo: number, expiresInDays: number): string {
  return restamp(pem, BOOT - issuedDaysAgo * DAY, BOOT + expiresInDays * DAY);
}

/** The demo issuing CA, valid well around every leaf it signed. */
export function issuerCa(): string {
  return stamped(DEMO_ISSUER_CA, 400, 1425);
}
