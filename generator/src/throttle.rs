//! A polite request pacer: at most one request per `interval`, shared by every
//! task that talks to an outside service. A back-off pushes the next slot out for
//! everyone, so one "429 Too Many Requests" slows the whole generator down.

use std::time::Duration;

use tokio::{
    sync::Mutex,
    time::{sleep_until, Instant},
};

pub struct Throttle {
    interval: Duration,
    next: Mutex<Instant>,
}

impl Throttle {
    /// `per_second` may be fractional, e.g. 0.5 = one request every two seconds.
    pub fn per_second(per_second: f64) -> Self {
        let per_second = if per_second.is_finite() && per_second > 0.0 {
            per_second
        } else {
            1.0
        };
        Self {
            interval: Duration::from_secs_f64(1.0 / per_second),
            next: Mutex::new(Instant::now()),
        }
    }

    /// Wait for our turn. Holding the lock while sleeping keeps requests in order.
    pub async fn wait(&self) {
        let mut next = self.next.lock().await;
        sleep_until(*next).await;
        *next = Instant::now() + self.interval;
    }

    /// Delay everyone's next request by at least `pause`.
    pub async fn pause(&self, pause: Duration) {
        let mut next = self.next.lock().await;
        *next = (*next).max(Instant::now() + pause);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn spaces_requests_out() {
        let t = Throttle::per_second(2.0);
        let start = Instant::now();
        for _ in 0..5 {
            t.wait().await;
        }
        // First goes immediately, then 4 × 0.5 s.
        assert_eq!(start.elapsed().as_millis(), 2000);
        t.pause(Duration::from_secs(10)).await;
        let before = Instant::now();
        t.wait().await;
        assert!(before.elapsed() >= Duration::from_secs(10));
    }
}
