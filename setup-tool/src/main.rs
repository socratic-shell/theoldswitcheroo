use clap::Parser;
use std::process::Command;

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
    
    // Download openvscode-server
    println!("Installing openvscode-server...");
    let install_script = r#"
        cd ~/.socratic-shell/theoldswitcheroo/
        curl -L https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v1.95.3/openvscode-server-v1.95.3-linux-x64.tar.gz -o openvscode-server.tar.gz
        tar -xzf openvscode-server.tar.gz
        mv openvscode-server-v1.95.3-linux-x64 openvscode-server
        chmod +x openvscode-server/bin/openvscode-server
    "#;
    
    let output = Command::new("ssh")
        .arg(&args.host)
        .arg(install_script)
        .output()?;
    
    if !output.status.success() {
        eprintln!("Installation failed: {}", String::from_utf8_lossy(&output.stderr));
        std::process::exit(1);
    }
    
    println!("Starting server on port 3000...");
    
    // Start server with parent monitoring wrapper
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
    
    // Keep SSH connection alive and stream logs
    let mut child = Command::new("ssh")
        .arg(&args.host)
        .arg(wrapper_script)
        .spawn()?;
    
    // Wait for process to complete (or Ctrl+C)
    child.wait()?;
    
    Ok(())
}
