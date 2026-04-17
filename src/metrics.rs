use once_cell::sync::Lazy;
use prometheus::{
    register_histogram_vec, register_int_counter, HistogramVec, IntCounter,
};

pub static INTERACTION_TIMER: Lazy<HistogramVec> = Lazy::new(|| {
    register_histogram_vec!(
        "interaction_execution_seconds",
        "Time to execute a Discord interaction",
        &["command", "subcommand", "is_autocomplete"]
    )
    .expect("Failed to register interaction timer metric")
});

pub static VOICE_SESSION_TIMER: Lazy<HistogramVec> = Lazy::new(|| {
    register_histogram_vec!(
        "voice_session_execution_seconds",
        "Time to handle a voice session event",
        &["event"]
    )
    .expect("Failed to register voice session timer metric")
});

pub static RESET_TIMER: Lazy<HistogramVec> = Lazy::new(|| {
    register_histogram_vec!(
        "reset_execution_seconds",
        "Time to complete a reset operation",
        &["action"]
    )
    .expect("Failed to register reset timer metric")
});

pub static ERRORS_TOTAL: Lazy<IntCounter> = Lazy::new(|| {
    register_int_counter!("errors_total", "Total number of errors encountered")
        .expect("Failed to register errors counter")
});

/// Force-initialize all metrics (zero them out) so Prometheus sees them from startup.
pub fn init() {
    // Touch each metric to register it
    let _ = &*INTERACTION_TIMER;
    let _ = &*VOICE_SESSION_TIMER;
    let _ = &*RESET_TIMER;
    let _ = &*ERRORS_TOTAL;

    // Zero known label combinations
    for event in &["join", "leave", "switch"] {
        VOICE_SESSION_TIMER
            .get_metric_with_label_values(&[event])
            .ok();
    }
    for action in &["daily", "monthly"] {
        RESET_TIMER.get_metric_with_label_values(&[action]).ok();
    }
}
