//! Bounded reads of user-picked local files (resource wizards). Everything
//! runs against files in a temp dir; no user file is ever read.

use base64::Engine;
use kubepit_core::local_files::{read_local_file, MAX_LOCAL_FILE_BYTES};

fn decode(b64: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap()
}

#[test]
fn reads_a_text_file_as_base64() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.properties");
    std::fs::write(&path, "feature.enabled=true\ngreeting=merhaba dünya\n").unwrap();

    let file = read_local_file(&path, MAX_LOCAL_FILE_BYTES).unwrap();
    assert_eq!(file.name, "app.properties");
    assert_eq!(file.path, path.to_string_lossy());
    assert!(file.utf8);
    assert_eq!(file.size, std::fs::metadata(&path).unwrap().len());
    assert_eq!(
        decode(&file.base64),
        "feature.enabled=true\ngreeting=merhaba dünya\n".as_bytes()
    );
}

#[test]
fn binary_files_round_trip_and_are_not_utf8() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("logo.png");
    let bytes: Vec<u8> = vec![
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80,
    ];
    std::fs::write(&path, &bytes).unwrap();

    let file = read_local_file(&path, MAX_LOCAL_FILE_BYTES).unwrap();
    assert!(!file.utf8);
    assert_eq!(file.size, bytes.len() as u64);
    assert_eq!(decode(&file.base64), bytes);
}

#[test]
fn empty_files_are_fine() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty");
    std::fs::write(&path, "").unwrap();

    let file = read_local_file(&path, MAX_LOCAL_FILE_BYTES).unwrap();
    assert_eq!(file.size, 0);
    assert!(file.utf8);
    assert_eq!(file.base64, "");
}

#[test]
fn enforces_the_size_limit_without_echoing_content() {
    let dir = tempfile::tempdir().unwrap();
    let exact = dir.path().join("exact.bin");
    std::fs::write(&exact, vec![b'a'; 64]).unwrap();
    assert_eq!(read_local_file(&exact, 64).unwrap().size, 64);

    let large = dir.path().join("large.key");
    std::fs::write(&large, "TOPSECRET".repeat(8)).unwrap();
    let err = format!("{:#}", read_local_file(&large, 64).unwrap_err());
    assert!(err.contains("too large"), "{err}");
    assert!(err.contains("72 B"), "{err}");
    assert!(err.contains("64 B"), "{err}");
    assert!(!err.contains("TOPSECRET"), "{err}");
}

#[test]
fn the_default_limit_is_one_mebibyte() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.txt");
    std::fs::write(&path, vec![b'x'; MAX_LOCAL_FILE_BYTES as usize + 1]).unwrap();
    let err = format!(
        "{:#}",
        read_local_file(&path, MAX_LOCAL_FILE_BYTES).unwrap_err()
    );
    assert!(err.contains("1.0 MiB"), "{err}");
}

#[test]
fn missing_files_and_folders_are_errors() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("nope.crt");
    let err = format!(
        "{:#}",
        read_local_file(&missing, MAX_LOCAL_FILE_BYTES).unwrap_err()
    );
    assert!(err.contains("cannot read"), "{err}");
    assert!(err.contains("nope.crt"), "{err}");

    let err = format!(
        "{:#}",
        read_local_file(dir.path(), MAX_LOCAL_FILE_BYTES).unwrap_err()
    );
    assert!(err.contains("is a folder"), "{err}");
}
