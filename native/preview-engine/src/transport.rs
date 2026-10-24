//! Independent bounded control input and serialized binary output. A broken parent pipe
//! stops decoding; a self-only watchdog also bounds native API stalls after parent death.
use crate::{
    AppResult,
    control::{Cancellation, Control},
    protocol::{self, Command, Request},
};
use std::{
    io,
    sync::{Arc, Mutex, atomic::Ordering},
    thread,
    time::Duration,
};
pub struct Transport {
    pub control: Arc<Control>,
    output: Arc<Mutex<io::Stdout>>,
    input_error: Arc<Mutex<Option<String>>>,
}
impl Transport {
    pub fn new() -> AppResult<Self> {
        let control = Control::new();
        let output = Arc::new(Mutex::new(io::stdout()));
        let input_error = Arc::new(Mutex::new(None));
        let state = control.clone();
        let sink = output.clone();
        let failure = input_error.clone();
        thread::Builder::new()
            .name("motion-control".into())
            .spawn(move || {
                let mut input = io::stdin().lock();
                loop {
                    match protocol::read_request(&mut input) {
                        Ok(Some(request)) => {
                            let shutdown = matches!(request.command, Command::Shutdown);
                            let rejected = state.push(request);
                            let mut failed = false;
                            for (old, reason) in rejected {
                                let result = sink
                                    .lock()
                                    .map_err(|_| "output mutex poisoned")
                                    .and_then(|mut output| {
                                        protocol::send(
                                            &mut *output,
                                            old.id,
                                            old.generation,
                                            serde_json::Value::Null,
                                            &[],
                                            Some(reason),
                                        )
                                        .map_err(|_| "output pipe closed")
                                    });
                                if result.is_err() {
                                    failed = true;
                                    break;
                                }
                            }
                            if failed {
                                break;
                            }
                            // The queued shutdown owns the final close acknowledgment. Do not clear it
                            // as if this were EOF, and do not accept any requests behind shutdown.
                            if shutdown {
                                return;
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            if let Ok(mut stored) = failure.lock() {
                                *stored = Some(error.to_string());
                            }
                            break;
                        }
                    }
                }
                state.disconnect();
                // No parent remains to enforce request deadlines. Exit ONLY this helper if a driver
                // stalls during release; never terminate another process by name.
                let _ = thread::Builder::new()
                    .name("motion-parent-watchdog".into())
                    .spawn(move || {
                        thread::sleep(Duration::from_secs(5));
                        if !state.finished.load(Ordering::Acquire) {
                            std::process::exit(2);
                        }
                    });
            })?;
        Ok(Self {
            control,
            output,
            input_error,
        })
    }
    pub fn next(&self) -> Option<(Request, Cancellation)> {
        self.control.next()
    }
    pub fn send(
        &self,
        request: &Request,
        value: serde_json::Value,
        pixels: &[u8],
        error: Option<&str>,
    ) -> AppResult<()> {
        let mut output = self.output.lock().map_err(|_| "output mutex poisoned")?;
        protocol::send(
            &mut *output,
            request.id,
            request.generation,
            value,
            pixels,
            error,
        )
    }
    pub fn check_input(&self) -> AppResult<()> {
        if let Some(error) = self
            .input_error
            .lock()
            .map_err(|_| "input error mutex poisoned")?
            .as_ref()
        {
            return Err(error.clone().into());
        }
        Ok(())
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.control.finished.store(true, Ordering::Release);
        self.control.disconnect();
    }
}
