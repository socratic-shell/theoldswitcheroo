use clap::Parser;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

fn detect_remote_architecture(host: &str) -> Result<String, Box<dyn std::error::Error>> {
    println!("Detecting remote architecture...");
    let output = Command::new("ssh")
        .arg(host)
        .arg("uname -m")
        .output()?;
    
    if !output.status.success() {
        return Err("Failed to detect remote architecture".into());
    }
    
    let arch_output = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
    let openvscode_arch = match arch_output.as_str() {
        "x86_64" => "linux-x64",
        "aarch64" | "arm64" => "linux-arm64",
        _ => {
            eprintln!("Warning: Unknown architecture '{}', defaulting to linux-x64", arch_output);
            "linux-x64"
        }
    };
    
    println!("Detected architecture: {} -> {}", arch_output, openvscode_arch);
    Ok(openvscode_arch.to_string())
}

#[derive(Parser)]
#[command(name = "setup-tool")]
#[command(about = "Deploy openvscode-server to remote hosts")]
struct Args {
    #[arg(long)]
    host: String,
    
    #[arg(long)]
    #[arg(help = "Target architecture: linux-x64, linux-arm64 (auto-detected if not specified)")]
    arch: Option<String>,
    
    #[arg(long)]
    #[arg(help = "Clear cached binaries before installation")]
    clear_cache: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    
    // Setup Ctrl+C handler
    let running = Arc::new(AtomicBool::new(true));
    let r = running.clone();
    
    ctrlc::set_handler(move || {
        println!("\nShutting down...");
        cleanup_session_file();
        r.store(false, Ordering::SeqCst);
        std::process::exit(0);
    })?;
    
    println!("Connecting to {}...", args.host);
    
    // Test SSH connection
    let output = Command::new("ssh")
        .arg(&args.host)
        .arg("echo 'SSH connection successful'")
        .output()?;
    
    if !output.status.success() {
        eprintln!("SSH connection failed: {}", String::from_utf8_lossy(&output.stderr));
        std::process::exit(1);
    }
    
    println!("{}", String::from_utf8_lossy(&output.stdout).trim());
    
    // Detect or use specified architecture
    let arch = match args.arch {
        Some(arch) => {
            println!("Using specified architecture: {}", arch);
            arch
        }
        None => detect_remote_architecture(&args.host)?
    };
    
    // Create cache directory
    println!("Creating cache directory...");
    let output = Command::new("ssh")
        .arg(&args.host)
        .arg("mkdir -p ~/.socratic-shell/theoldswitcheroo/")
        .output()?;
    
    if !output.status.success() {
        eprintln!("Failed to create directory: {}", String::from_utf8_lossy(&output.stderr));
        std::process::exit(1);
    }
    
    // Download and install openvscode-server with streaming output
    println!("Installing openvscode-server for {}...", arch);
    let clear_cache_cmd = if args.clear_cache { "rm -rf openvscode-server.tar.gz openvscode-server" } else { "" };
    let install_script = format!(r#"
        cd ~/.socratic-shell/theoldswitcheroo/
        {}
        if [ ! -f openvscode-server.tar.gz ]; then
            curl -L https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v1.103.1/openvscode-server-v1.103.1-{}.tar.gz -o openvscode-server.tar.gz
        fi
        if [ ! -d openvscode-server ]; then
            tar -xzf openvscode-server.tar.gz
            mv openvscode-server-v1.103.1-{} openvscode-server
            chmod +x openvscode-server/bin/openvscode-server
        fi
    "#, clear_cache_cmd, arch, arch);
    
    let mut install_child = Command::new("ssh")
        .arg(&args.host)
        .arg(install_script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    
    // Stream installation output
    if let Some(stdout) = install_child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            println!("{}", line?);
        }
    }
    
    install_child.wait()?;
    
    println!("Starting server on port 8765...");
    
    // Write session file (always localhost since we're port forwarding)
    write_session_file("localhost", 8765)?;
    
    // Start server with parent monitoring wrapper and stream logs
    let wrapper_script = r#"
        cd ~/.socratic-shell/theoldswitcheroo/
        ./openvscode-server/bin/openvscode-server --host 0.0.0.0 --port 8765 --without-connection-token &
        SERVER_PID=$!
        
        # Wait a moment for server to start or fail
        sleep 2
        
        # Check if server process is still running
        if ! kill -0 $SERVER_PID 2>/dev/null; then
            echo "ERROR: openvscode-server failed to start"
            echo "This is often caused by architecture mismatch (wrong --arch parameter)"
            echo "Try: --arch linux-arm64 for ARM64 systems, --arch linux-x64 for x86_64 systems"
            exit 1
        fi
        
        # Monitor parent process and cleanup on exit
        while kill -0 $PPID 2>/dev/null; do sleep 1; done
        kill $SERVER_PID 2>/dev/null
    "#;
    
    println!("✓ Connection established.");
    println!("  VSCode available at: http://localhost:8765 (forwarded from {}:8765)", args.host);
    println!("  ");
    println!("  Press Ctrl+C to shutdown and cleanup.");
    println!("");
    
    // Stream server logs with port forwarding
    let mut server_child = Command::new("ssh")
        .arg("-L")
        .arg("8765:localhost:8765")
        .arg(&args.host)
        .arg(wrapper_script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    
    // Stream server output
    if let Some(stdout) = server_child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = line?;
            println!("[{}] {}", chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"), line);
        }
    }
    
    server_child.wait()?;
    cleanup_session_file();
    
    Ok(())
}

fn write_session_file(host: &str, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let session_dir = format!("{}/.socratic-shell/theoldswitcheroo", home);
    let session_file = format!("{}/session.json", session_dir);
    
    // Create directory if it doesn't exist
    fs::create_dir_all(&session_dir)?;
    
    let session_data = serde_json::json!({
        "host": host,
        "port": port
    });
    
    fs::write(&session_file, session_data.to_string())?;
    Ok(())
}

fn cleanup_session_file() {
    let home = std::env::var("HOME").unwrap_or_default();
    let session_file = format!("{}/.socratic-shell/theoldswitcheroo/session.json", home);
    
    if Path::new(&session_file).exists() {
        let _ = fs::remove_file(&session_file);
        println!("✓ Remote server terminated.");
    }
}
