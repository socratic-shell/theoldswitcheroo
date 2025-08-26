use clap::Parser;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};

#[derive(Parser)]
#[command(name = "setup-tool")]
#[command(about = "Deploy openvscode-server to remote hosts")]
struct Args {
    #[arg(long)]
    host: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    
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
    println!("Installing openvscode-server...");
    let install_script = r#"
        cd ~/.socratic-shell/theoldswitcheroo/
        if [ ! -f openvscode-server.tar.gz ]; then
            curl -L https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v1.103.1/openvscode-server-v1.103.1-linux-x64.tar.gz -o openvscode-server.tar.gz
        fi
        if [ ! -d openvscode-server ]; then
            tar -xzf openvscode-server.tar.gz
            mv openvscode-server-v1.103.1-linux-x64 openvscode-server
            chmod +x openvscode-server/bin/openvscode-server
        fi
    "#;
    
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
    
    println!("Starting server on port 3000...");
    
    // Start server with parent monitoring wrapper and stream logs
    let wrapper_script = r#"
        cd ~/.socratic-shell/theoldswitcheroo/
        ./openvscode-server/bin/openvscode-server --host 0.0.0.0 --port 3000 --without-connection-token &
        SERVER_PID=$!
        while kill -0 $PPID 2>/dev/null; do sleep 1; done
        kill $SERVER_PID 2>/dev/null
    "#;
    
    println!("✓ Connection established.");
    println!("  VSCode available at: http://{}:3000", args.host);
    println!("  ");
    println!("  Press Ctrl+C to shutdown and cleanup.");
    println!("");
    
    // Stream server logs
    let mut server_child = Command::new("ssh")
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
    
    Ok(())
}
