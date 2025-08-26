use clap::Parser;

#[derive(Parser)]
#[command(name = "setup-tool")]
#[command(about = "Deploy openvscode-server to remote hosts")]
struct Args {
    #[arg(long)]
    host: String,
}

fn main() {
    let args = Args::parse();
    println!("Connecting to {}...", args.host);
}
