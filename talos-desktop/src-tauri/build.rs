fn main() {
    // main.rs bakes in TALOS_SERVER_URL as a fallback, so rebuild when it changes.
    println!("cargo:rerun-if-env-changed=TALOS_SERVER_URL");
    tauri_build::build()
}
