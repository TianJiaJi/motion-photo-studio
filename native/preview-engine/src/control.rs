//! Bounded control mailbox. Input runs independently of decoding; same-drag seeks coalesce
//! without cancelling the active frame, while a new interaction epoch interrupts stale work.
use crate::{
    AppResult,
    protocol::{Command, Request},
};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
const MAX_COMMANDS: usize = 8;
fn target(command: &Command) -> bool {
    matches!(command, Command::Seek { .. } | Command::Locate { .. })
}
fn low_priority(command: &Command) -> bool {
    matches!(
        command,
        Command::Thumbnail { .. } | Command::Prefetch { .. }
    )
}
fn cancellable(command: &Command) -> bool {
    !matches!(command, Command::Hello | Command::Stats | Command::Shutdown)
}
fn urgent(command: &Command) -> bool {
    matches!(
        command,
        Command::Close | Command::Shutdown | Command::AudioStop
    )
}
struct Mailbox {
    queue: VecDeque<Request>,
}
pub struct Control {
    mailbox: Mutex<Mailbox>,
    ready: Condvar,
    generation: AtomicU64,
    interrupt: AtomicU64,
    closed: AtomicBool,
    foreground_waiting: AtomicBool,
    coalesced: AtomicU64,
    pub finished: AtomicBool,
}
#[derive(Clone)]
pub struct Cancellation {
    control: Arc<Control>,
    generation: u64,
    interrupt: u64,
    low_priority: bool,
}
impl Cancellation {
    pub fn check(&self) -> AppResult<()> {
        if self.control.closed.load(Ordering::Acquire)
            || self.control.generation.load(Ordering::Acquire) > self.generation
            || self.control.interrupt.load(Ordering::Acquire) != self.interrupt
            || self.low_priority && self.control.foreground_waiting.load(Ordering::Acquire)
        {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    }
}
impl Control {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            mailbox: Mutex::new(Mailbox {
                queue: VecDeque::new(),
            }),
            ready: Condvar::new(),
            generation: AtomicU64::new(0),
            interrupt: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            foreground_waiting: AtomicBool::new(false),
            coalesced: AtomicU64::new(0),
            finished: AtomicBool::new(false),
        })
    }
    fn poisoned(&self) {
        // Never resume a possibly inconsistent queue after a panic while holding its lock.
        self.closed.store(true, Ordering::Release);
        self.interrupt.fetch_add(1, Ordering::AcqRel);
        self.ready.notify_all();
        eprintln!("motion-preview: control mutex poisoned; stopping session");
    }
    fn lock_mailbox(&self) -> std::sync::MutexGuard<'_, Mailbox> {
        match self.mailbox.lock() {
            Ok(mailbox) => mailbox,
            Err(error) => {
                self.poisoned();
                let mut mailbox = error.into_inner();
                mailbox.queue.clear();
                mailbox
            }
        }
    }
    // Return displaced/rejected identities so the transport ALWAYS settles their promises.
    pub fn push(&self, request: Request) -> Vec<(Request, &'static str)> {
        let mut mailbox = self.lock_mailbox();
        let mut discarded = Vec::new();
        if self.closed.load(Ordering::Acquire)
            || cancellable(&request.command)
                && request.generation < self.generation.load(Ordering::Acquire)
        {
            return vec![(request, "cancelled")];
        }
        self.generation
            .fetch_max(request.generation, Ordering::AcqRel);
        let disrupting = matches!(
            request.command,
            Command::Open { .. } | Command::Close | Command::Shutdown | Command::AudioStop
        );
        if disrupting {
            self.interrupt.fetch_add(1, Ordering::AcqRel);
        }
        let mut retained = VecDeque::new();
        while let Some(old) = mailbox.queue.pop_front() {
            let stale = cancellable(&old.command) && old.generation < request.generation;
            let replaced = target(&old.command)
                && target(&request.command)
                && old.generation == request.generation;
            let cleared = disrupting && cancellable(&old.command);
            if stale || replaced || cleared {
                self.coalesced.fetch_add(1, Ordering::Relaxed);
                discarded.push((old, "cancelled"));
            } else {
                retained.push_back(old);
            }
        }
        mailbox.queue = retained;
        if mailbox.queue.len() >= MAX_COMMANDS {
            discarded.push((request, "busy"));
        } else if urgent(&request.command) {
            mailbox.queue.push_front(request);
        } else {
            mailbox.queue.push_back(request);
        }
        self.foreground_waiting.store(
            mailbox.queue.iter().any(|r| !low_priority(&r.command)),
            Ordering::Release,
        );
        self.ready.notify_one();
        discarded
    }
    pub fn next(self: &Arc<Self>) -> Option<(Request, Cancellation)> {
        let mut mailbox = self.lock_mailbox();
        loop {
            if self.closed.load(Ordering::Acquire) {
                return None;
            }
            if !mailbox.queue.is_empty() {
                let position = mailbox
                    .queue
                    .iter()
                    .position(|r| !low_priority(&r.command))
                    .unwrap_or(0);
                let request = mailbox.queue.remove(position)?;
                self.foreground_waiting.store(
                    mailbox.queue.iter().any(|r| !low_priority(&r.command)),
                    Ordering::Release,
                );
                let token = Cancellation {
                    control: self.clone(),
                    generation: request.generation,
                    interrupt: self.interrupt.load(Ordering::Acquire),
                    low_priority: low_priority(&request.command),
                };
                return Some((request, token));
            }
            mailbox = match self.ready.wait(mailbox) {
                Ok(mailbox) => mailbox,
                Err(error) => {
                    self.poisoned();
                    let mut mailbox = error.into_inner();
                    mailbox.queue.clear();
                    mailbox
                }
            };
        }
    }
    pub fn idle(&self) -> bool {
        let mailbox = self.lock_mailbox();
        !self.closed.load(Ordering::Acquire) && mailbox.queue.is_empty()
    }
    pub fn disconnect(&self) {
        let mut mailbox = self.lock_mailbox();
        self.closed.store(true, Ordering::Release);
        self.interrupt.fetch_add(1, Ordering::AcqRel);
        mailbox.queue.clear();
        self.ready.notify_all();
    }
    pub fn stats(&self) -> serde_json::Value {
        serde_json::json!({"pending":self.lock_mailbox().queue.len(),
            "maximumPending":MAX_COMMANDS,"coalesced":self.coalesced.load(Ordering::Relaxed)})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn seek(id: u64, generation: u64) -> Request {
        Request {
            version: 1,
            id,
            generation,
            command: Command::Locate {
                time_hns: id.to_string(),
                seek_hns: Some("0".into()),
                playback: false,
            },
        }
    }
    #[test]
    fn active_frame_finishes_and_only_latest_target_waits() {
        let control = Control::new();
        assert!(control.push(seek(1, 1)).is_empty());
        let Some((_, active)) = control.next() else {
            panic!("active request missing")
        };
        for id in 2..1000 {
            let replaced = control.push(seek(id, 1));
            assert_eq!(replaced.len(), usize::from(id > 2));
            assert!(active.check().is_ok());
        }
        let Some((latest, _)) = control.next() else {
            panic!("pending request missing")
        };
        assert_eq!(latest.id, 999);
        assert!(control.idle());
        control.push(seek(1000, 2));
        assert!(active.check().is_err());
    }
    #[test]
    fn queue_is_bounded_and_foreground_interrupts_thumbnail() {
        let control = Control::new();
        control.push(Request {
            version: 1,
            id: 1,
            generation: 1,
            command: Command::Thumbnail {
                time_hns: "0".into(),
                seek_hns: "0".into(),
            },
        });
        let Some((_, thumbnail)) = control.next() else {
            panic!("thumbnail request missing")
        };
        control.push(seek(2, 1));
        assert!(thumbnail.check().is_err());
        for id in 3..30 {
            control.push(Request {
                version: 1,
                id,
                generation: 1,
                command: Command::Stats,
            });
        }
        assert_eq!(control.stats()["pending"], MAX_COMMANDS);
        control.disconnect();
        assert!(control.next().is_none());
    }
}
