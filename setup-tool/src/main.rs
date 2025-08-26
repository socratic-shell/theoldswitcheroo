use clap::Parser;
use ssh2::Session;
use std::io::Read;
use std::net::TcpStream;

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
    
    // Connect via SSH
    let tcp = TcpStream::connect(format!("{}:22", args.host))?;
    let mut sess = Session::new()?;
    sess.set_tcp_stream(tcp);
    sess.handshake()?;
    
    // Use SSH agent for authentication
    sess.userauth_agent(&std::env::var("USER")?)?;
    
    // Test connection with simple command
    let mut channel = sess.channel_session()?;
    channel.exec("echo 'SSH connection successful'")?;
    
    let mut output = String::new();
    channel.read_to_string(&mut output)?;
    println!("{}", output.trim());
    
    channel.wait_close()?;
    println!("✓ Connection established.");
    
    Ok(())
}
