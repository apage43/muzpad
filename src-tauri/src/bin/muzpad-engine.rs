use std::path::Path;

fn main() {
    if let Err(error)=entry() {
        eprintln!("muzpad-engine: {error:#}");
        std::process::exit(1);
    }
}
fn entry()->anyhow::Result<()> {
    let mut arguments=std::env::args_os().skip(1);
    if let Some(mode)=arguments.next() {
        if mode=="--export-worker" {
            let directory=arguments.next().ok_or_else(||anyhow::anyhow!("Missing export job directory"))?;
            anyhow::ensure!(arguments.next().is_none(),"Unexpected worker arguments");
            return muzpad_desktop::engine::exports::run_worker(Path::new(&directory));
        }
        anyhow::bail!("Unknown internal engine mode");
    }
    #[cfg(unix)] {
        use std::os::fd::FromRawFd;
        fn inherited(name:&str)->anyhow::Result<i32> {
            let fd=std::env::var(name)?.parse::<i32>()?;
            anyhow::ensure!(fd>2,"Protocol must use dedicated inherited descriptors");
            let flags=unsafe{libc::fcntl(fd,libc::F_GETFD)};
            if flags<0{return Err(std::io::Error::last_os_error().into());}
            if unsafe{libc::fcntl(fd,libc::F_SETFD,flags|libc::FD_CLOEXEC)}<0{return Err(std::io::Error::last_os_error().into());}
            Ok(fd)
        }
        let read=inherited("MUZPAD_PROTOCOL_READ_FD")?;
        let write=inherited("MUZPAD_PROTOCOL_WRITE_FD")?;
        anyhow::ensure!(read!=write,"Protocol descriptors must be distinct");
        let reader=unsafe{std::fs::File::from_raw_fd(read)};
        let writer=unsafe{std::fs::File::from_raw_fd(write)};
        muzpad_desktop::engine::run(reader,writer)
    }
    #[cfg(not(unix))] {anyhow::bail!("Dedicated native protocol handles are not implemented on this platform")}
}
