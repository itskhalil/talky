use serde::Serialize;

use super::types::ReplaySegment;

#[derive(Clone, Debug, Serialize)]
pub struct ScoreResult {
    pub mic_wer: f64,
    pub spk_wer: f64,
    pub combined_wer: f64,
    pub mic_word_count: usize,
    pub spk_word_count: usize,
    pub mic_segment_count: usize,
    pub spk_segment_count: usize,
    pub golden_mic_segment_count: usize,
    pub golden_spk_segment_count: usize,
    pub channel_misattributions: usize,
}

/// Compute WER and channel attribution accuracy between replay output and golden transcript.
pub fn score(replay: &[ReplaySegment], golden: &[ReplaySegment]) -> ScoreResult {
    // Concatenate text by channel
    let replay_mic = concat_channel(replay, "mic");
    let replay_spk = concat_channel(replay, "speaker");
    let golden_mic = concat_channel(golden, "mic");
    let golden_spk = concat_channel(golden, "speaker");

    let mic_wer = word_error_rate(&golden_mic, &replay_mic);
    let spk_wer = word_error_rate(&golden_spk, &replay_spk);

    let golden_mic_words = tokenize(&golden_mic).len();
    let golden_spk_words = tokenize(&golden_spk).len();
    let total_words = golden_mic_words + golden_spk_words;

    let combined_wer = if total_words > 0 {
        let mic_errors = (mic_wer * golden_mic_words as f64).round() as usize;
        let spk_errors = (spk_wer * golden_spk_words as f64).round() as usize;
        (mic_errors + spk_errors) as f64 / total_words as f64
    } else {
        0.0
    };

    // Channel misattribution: check if replay has words on the wrong channel
    let misattributions = count_misattributions(replay, golden);

    ScoreResult {
        mic_wer,
        spk_wer,
        combined_wer,
        mic_word_count: golden_mic_words,
        spk_word_count: golden_spk_words,
        mic_segment_count: replay.iter().filter(|s| s.source == "mic").count(),
        spk_segment_count: replay.iter().filter(|s| s.source == "speaker").count(),
        golden_mic_segment_count: golden.iter().filter(|s| s.source == "mic").count(),
        golden_spk_segment_count: golden.iter().filter(|s| s.source == "speaker").count(),
        channel_misattributions: misattributions,
    }
}

/// Standard Word Error Rate via edit distance DP.
/// WER = (substitutions + deletions + insertions) / reference_length
fn word_error_rate(reference: &str, hypothesis: &str) -> f64 {
    let ref_words = tokenize(reference);
    let hyp_words = tokenize(hypothesis);

    if ref_words.is_empty() {
        return if hyp_words.is_empty() { 0.0 } else { 1.0 };
    }

    let n = ref_words.len();
    let m = hyp_words.len();

    // DP table: dp[i][j] = min edit distance for ref[0..i] vs hyp[0..j]
    let mut dp = vec![vec![0usize; m + 1]; n + 1];

    for i in 0..=n {
        dp[i][0] = i; // deletions
    }
    for j in 0..=m {
        dp[0][j] = j; // insertions
    }

    for i in 1..=n {
        for j in 1..=m {
            let cost = if ref_words[i - 1].eq_ignore_ascii_case(&hyp_words[j - 1]) {
                0
            } else {
                1
            };
            dp[i][j] = (dp[i - 1][j] + 1) // deletion
                .min(dp[i][j - 1] + 1)      // insertion
                .min(dp[i - 1][j - 1] + cost); // substitution
        }
    }

    dp[n][m] as f64 / n as f64
}

fn tokenize(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

fn concat_channel(segments: &[ReplaySegment], channel: &str) -> String {
    let mut sorted: Vec<_> = segments.iter().filter(|s| s.source == channel).collect();
    sorted.sort_by_key(|s| s.start_ms);
    sorted
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Count golden segments whose words appear substantially on the wrong channel in replay.
fn count_misattributions(replay: &[ReplaySegment], golden: &[ReplaySegment]) -> usize {
    let mut count = 0;

    for g in golden {
        let g_words = tokenize(&g.text);
        if g_words.is_empty() {
            continue;
        }

        let wrong_channel = if g.source == "mic" { "speaker" } else { "mic" };

        // Check if >50% of golden words appear in wrong-channel replay segments
        // that overlap in time
        let wrong_segments: Vec<_> = replay
            .iter()
            .filter(|r| {
                r.source == wrong_channel
                    && r.start_ms < g.end_ms
                    && r.end_ms > g.start_ms
            })
            .collect();

        if wrong_segments.is_empty() {
            continue;
        }

        let wrong_text: String = wrong_segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let wrong_words = tokenize(&wrong_text);

        let matched = g_words
            .iter()
            .filter(|w| wrong_words.iter().any(|ww| ww.eq_ignore_ascii_case(w)))
            .count();

        if matched > g_words.len() / 2 {
            count += 1;
        }
    }

    count
}

/// Format a score result as a human-readable table.
pub fn format_score_table(score: &ScoreResult) -> String {
    let mut out = String::new();
    out.push_str("=== Replay Score ===\n");
    out.push_str(&format!("Combined WER:       {:.1}%\n", score.combined_wer * 100.0));
    out.push_str(&format!("  Mic WER:          {:.1}% ({} ref words)\n", score.mic_wer * 100.0, score.mic_word_count));
    out.push_str(&format!("  Speaker WER:      {:.1}% ({} ref words)\n", score.spk_wer * 100.0, score.spk_word_count));
    out.push_str(&format!("Segments (replay):  {} mic, {} spk\n", score.mic_segment_count, score.spk_segment_count));
    out.push_str(&format!("Segments (golden):  {} mic, {} spk\n", score.golden_mic_segment_count, score.golden_spk_segment_count));
    out.push_str(&format!("Misattributions:    {}\n", score.channel_misattributions));
    out
}
