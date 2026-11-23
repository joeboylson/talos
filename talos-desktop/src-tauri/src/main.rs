// One window on the server's page. The page shows its "This machine" panel
// because talos runs on this same computer.

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

const SERVER_URL_ENV_KEY: &str = "TALOS_SERVER_URL";
const WINDOW_LABEL: &str = "main";
const WINDOW_TITLE: &str = "Talos";
const WINDOW_WIDTH: f64 = 900.0;
const WINDOW_HEIGHT: f64 = 700.0;

// The page is at the server's origin over http(s): ws://host:7070/x → http://host:7070.
// Any spelling talos accepts (WSS://, a space first) gives the same page, as
// talos-shared's httpOriginFromServerUrl does.
fn page_url_from_server_url(server_url: &str) -> String {
    let trimmed = server_url.trim();
    let scheme_end = trimmed.find(':').unwrap_or(0);
    let rest = &trimmed[scheme_end..];
    let host_start = if rest.starts_with("://") { 3 } else { 0 };
    let origin_end = rest[host_start..].find(['/', '?', '#']).map_or(rest.len(), |at| at + host_start);
    let origin_rest = &rest[..origin_end];
    match trimmed[..scheme_end].to_ascii_lowercase().as_str() {
        "wss" => format!("https{origin_rest}"),
        "ws" => format!("http{origin_rest}"),
        _ => format!("{}{origin_rest}", &trimmed[..scheme_end]),
    }
}

// The env at launch wins. An app opened from Finder has no env, so it falls
// back to the value baked in at build time (option_env! needs the literal name).
fn read_server_url() -> String {
    std::env::var(SERVER_URL_ENV_KEY)
        .ok()
        .or(option_env!("TALOS_SERVER_URL").map(String::from))
        .expect("TALOS_SERVER_URL is not set. Copy .env.example to .env and fill it in.")
}

fn main() {
    let page_url: Url = page_url_from_server_url(&read_server_url())
        .parse()
        .expect("TALOS_SERVER_URL isn't a valid URL");

    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(page_url.clone()))
                .title(WINDOW_TITLE)
                .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Talos desktop app failed to start");
}

#[cfg(test)]
mod tests {
    use super::page_url_from_server_url;

    #[test]
    fn turns_socket_addresses_into_page_addresses() {
        assert_eq!(page_url_from_server_url("ws://localhost:7070"), "http://localhost:7070");
        assert_eq!(page_url_from_server_url("wss://talos.example.com"), "https://talos.example.com");
    }

    #[test]
    fn reads_any_spelling_talos_accepts() {
        assert_eq!(page_url_from_server_url("WSS://talos.example.com"), "https://talos.example.com");
        assert_eq!(page_url_from_server_url(" wss://talos.example.com"), "https://talos.example.com");
        assert_eq!(page_url_from_server_url("Ws://localhost:7070"), "http://localhost:7070");
    }

    #[test]
    fn leaves_page_addresses_alone() {
        assert_eq!(page_url_from_server_url("http://localhost:7070"), "http://localhost:7070");
        assert_eq!(page_url_from_server_url("https://talos.example.com"), "https://talos.example.com");
    }

    #[test]
    fn keeps_only_the_origin() {
        assert_eq!(page_url_from_server_url("wss://talos.example.com/socket"), "https://talos.example.com");
        assert_eq!(page_url_from_server_url("ws://localhost:7070/?x=1"), "http://localhost:7070");
        assert_eq!(page_url_from_server_url("wss://talos.example.com#a"), "https://talos.example.com");
    }
}
