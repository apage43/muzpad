fn main() {
    println!("cargo:rerun-if-env-changed=MUZPAD_CORE_REVISION");
    println!("cargo:rerun-if-changed=core-revision");
    let revision = include_str!("core-revision").trim();
    assert!(revision.len() == 40 && revision.bytes().all(|c| c.is_ascii_hexdigit()), "core-revision must be a full git SHA");
    if let Ok(requested) = std::env::var("MUZPAD_CORE_REVISION") {
        assert_eq!(requested, revision, "MUZPAD_CORE_REVISION must match the verified src-tauri/core-revision pin");
    }
    println!("cargo:rustc-env=MUZPAD_CORE_REVISION={revision}");
    #[cfg(feature = "shell")]
    tauri_build::build();
}
