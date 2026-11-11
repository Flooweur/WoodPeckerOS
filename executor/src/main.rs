use woody_exec::{audit, config::Config, server};

fn usage() -> ! {
    eprintln!("usage:\n  woody-execd serve --config <file>\n  woody-execd audit-verify <audit.jsonl>");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["serve", "--config", path] => {
            let cfg = Config::load(path).unwrap_or_else(|e| {
                eprintln!("woody-execd: {e}");
                std::process::exit(1);
            });
            if let Err(e) = server::serve(cfg) {
                eprintln!("woody-execd: {e}");
                std::process::exit(1);
            }
        }
        ["audit-verify", path] => match audit::verify(path) {
            Ok(r) => println!("OK: {} records, head {}", r.records, r.last_hash),
            Err(e) => {
                eprintln!("AUDIT LOG INVALID: {e}");
                std::process::exit(1);
            }
        },
        _ => usage(),
    }
}
