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
    println!("✓ Connection established.");
    
    Ok(())
}
