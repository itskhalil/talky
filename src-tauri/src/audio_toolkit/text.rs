use log::debug;
use natural::phonetics::soundex;
use once_cell::sync::Lazy;
use regex::Regex;
use strsim::{levenshtein, normalized_levenshtein};

/// Applies custom word corrections to transcribed text using fuzzy matching
///
/// This function corrects words in the input text by finding the best matches
/// from a list of custom words using a combination of:
/// - Levenshtein distance for string similarity
/// - Soundex phonetic matching for pronunciation similarity
///
/// # Arguments
/// * `text` - The input text to correct
/// * `custom_words` - List of custom words to match against
/// * `threshold` - Maximum similarity score to accept (0.0 = exact match, 1.0 = any match)
///
/// # Returns
/// The corrected text with custom words applied
pub fn apply_custom_words(text: &str, custom_words: &[String], threshold: f64) -> String {
    if custom_words.is_empty() {
        return text.to_string();
    }

    // Pre-compute lowercase versions to avoid repeated allocations
    let custom_words_lower: Vec<String> = custom_words.iter().map(|w| w.to_lowercase()).collect();

    let words: Vec<&str> = text.split_whitespace().collect();
    let mut corrected_words = Vec::new();

    for word in words {
        let cleaned_word = word
            .trim_matches(|c: char| !c.is_alphabetic())
            .to_lowercase();

        if cleaned_word.is_empty() {
            corrected_words.push(word.to_string());
            continue;
        }

        // Skip extremely long words to avoid performance issues
        if cleaned_word.len() > 50 {
            corrected_words.push(word.to_string());
            continue;
        }

        let mut best_match: Option<&String> = None;
        let mut best_score = f64::MAX;

        for (i, custom_word_lower) in custom_words_lower.iter().enumerate() {
            // Skip if lengths are too different (optimization)
            let len_diff = (cleaned_word.len() as i32 - custom_word_lower.len() as i32).abs();
            if len_diff > 5 {
                continue;
            }

            // Calculate Levenshtein distance (normalized by length)
            let levenshtein_dist = levenshtein(&cleaned_word, custom_word_lower);
            let max_len = cleaned_word.len().max(custom_word_lower.len()) as f64;
            let levenshtein_score = if max_len > 0.0 {
                levenshtein_dist as f64 / max_len
            } else {
                1.0
            };

            // Calculate phonetic similarity using Soundex
            let phonetic_match = soundex(&cleaned_word, custom_word_lower);

            // Only apply phonetic boost when words are similar length.
            // This prevents false positives like "order" -> "Zephyra" where
            // phonetic similarity exists but lengths differ significantly.
            let len_ratio = cleaned_word.len().min(custom_word_lower.len()) as f64
                / cleaned_word.len().max(custom_word_lower.len()) as f64;

            let combined_score = if phonetic_match && len_ratio > 0.8 {
                levenshtein_score * 0.5 // Moderate boost for phonetic matches with similar length
            } else {
                levenshtein_score
            };

            // Accept if the score is good enough (configurable threshold)
            if combined_score < threshold && combined_score < best_score {
                best_match = Some(&custom_words[i]);
                best_score = combined_score;
            }
        }

        if let Some(replacement) = best_match {
            debug!(
                "Custom word match: '{}' -> '{}' (score: {:.3}, threshold: {})",
                word, replacement, best_score, threshold
            );
            // Preserve the original case pattern as much as possible
            let corrected = preserve_case_pattern(word, replacement);

            // Preserve punctuation from original word
            let (prefix, suffix) = extract_punctuation(word);
            corrected_words.push(format!("{}{}{}", prefix, corrected, suffix));
        } else {
            corrected_words.push(word.to_string());
        }
    }

    corrected_words.join(" ")
}

/// Preserves the case pattern of the original word when applying a replacement
fn preserve_case_pattern(original: &str, replacement: &str) -> String {
    if original.chars().all(|c| c.is_uppercase()) {
        replacement.to_uppercase()
    } else if original.chars().next().map_or(false, |c| c.is_uppercase()) {
        let mut chars: Vec<char> = replacement.chars().collect();
        if let Some(first_char) = chars.get_mut(0) {
            *first_char = first_char.to_uppercase().next().unwrap_or(*first_char);
        }
        chars.into_iter().collect()
    } else {
        replacement.to_string()
    }
}

/// Extracts punctuation prefix and suffix from a word
fn extract_punctuation(word: &str) -> (&str, &str) {
    let prefix_end = word.chars().take_while(|c| !c.is_alphabetic()).count();
    let suffix_start = word
        .char_indices()
        .rev()
        .take_while(|(_, c)| !c.is_alphabetic())
        .count();

    let prefix = if prefix_end > 0 {
        &word[..prefix_end]
    } else {
        ""
    };

    let suffix = if suffix_start > 0 {
        &word[word.len() - suffix_start..]
    } else {
        ""
    };

    (prefix, suffix)
}

/// Filler words to remove from transcriptions
const FILLER_WORDS: &[&str] = &[
    "uh", "um", "uhm", "umm", "uhh", "uhhh", "ah", "eh", "hmm", "hm", "mmm", "mm", "mh", "ha",
    "ehh",
];

static MULTI_SPACE_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s{2,}").unwrap());

/// Common hallucination patterns that Whisper produces on silent/noisy audio
static HALLUCINATION_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        // Single character or punctuation-only output
        Regex::new(r#"^[.!?…,;:'"]+$"#).unwrap(),
        // "Thank you" spam (common hallucination)
        Regex::new(r#"(?i)^(thank\s*you[.!,]?\s*)+$"#).unwrap(),
        // Repeated phrases like "Hello"
        Regex::new(r#"(?i)^(hello[.!,]?\s*){2,}$"#).unwrap(),
        Regex::new(r#"(?i)^(okay[.!,]?\s*){3,}$"#).unwrap(),
        // Music/sound descriptions (shouldn't appear in speech transcription)
        Regex::new(r#"(?i)^\[.*\]$"#).unwrap(),
        // Subtitle artifacts
        Regex::new(r#"(?i)^(subtitles|captions|transcribed|translated)\s*(by|:)"#).unwrap(),
        // URL-like patterns
        Regex::new(r#"(?i)^(www\.|https?://|\.com|\.org)"#).unwrap(),
        // Single "thank you" and multilingual equivalents (common Whisper silence hallucinations)
        Regex::new(r#"(?i)^(thank\s*you|thanks|gracias|merci|danke|grazie|obrigado|obrigada|спасибо|ありがとう|謝謝|감사합니다)[.!,]?$"#).unwrap(),
        // Goodbye variants
        Regex::new(r#"(?i)^(bye|goodbye|bye-bye|adios|ciao|au revoir)[.!,]?$"#).unwrap(),
        // Common single-word hallucinations
        Regex::new(r#"(?i)^(yes|no|yeah|yep|nope|hmm|huh|oh|ah)[.!,]?$"#).unwrap(),
    ]
});

/// Detects highly repetitive text (same phrase repeated 3+ times)
fn is_repetitive_hallucination(text: &str) -> bool {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() < 6 {
        return false;
    }

    // Check for phrase repetition (2-4 word phrases)
    for phrase_len in 2..=4 {
        if words.len() < phrase_len * 3 {
            continue;
        }

        let mut repetition_count = 0;
        let mut i = 0;
        while i + phrase_len <= words.len() {
            let phrase: Vec<&str> = words[i..i + phrase_len].to_vec();
            let phrase_lower: Vec<String> = phrase.iter().map(|w| w.to_lowercase()).collect();

            // Count how many times this phrase repeats consecutively
            let mut j = i + phrase_len;
            let mut consecutive = 1;
            while j + phrase_len <= words.len() {
                let next_phrase: Vec<String> = words[j..j + phrase_len]
                    .iter()
                    .map(|w| w.to_lowercase())
                    .collect();
                if next_phrase == phrase_lower {
                    consecutive += 1;
                    j += phrase_len;
                } else {
                    break;
                }
            }

            if consecutive >= 3 {
                repetition_count += consecutive;
            }
            i = j;
        }

        // If most of the text is repetitive phrases, it's likely a hallucination
        if repetition_count * phrase_len >= words.len() / 2 {
            return true;
        }
    }

    false
}

/// Checks if text matches known hallucination patterns
pub fn is_hallucination(text: &str) -> bool {
    let trimmed = text.trim();

    // Empty or very short text
    if trimmed.len() < 2 {
        return true;
    }

    // Single word that's not meaningful
    if !trimmed.contains(' ') && trimmed.len() < 3 {
        return true;
    }

    // Check against known patterns
    for pattern in HALLUCINATION_PATTERNS.iter() {
        if pattern.is_match(trimmed) {
            debug!("Hallucination pattern detected: '{}'", trimmed);
            return true;
        }
    }

    // Check for repetitive hallucinations
    if is_repetitive_hallucination(trimmed) {
        debug!("Repetitive hallucination detected: '{}'", trimmed);
        return true;
    }

    false
}

/// Removes overlapping prefix text from a new transcription.
/// When using audio overlap for context continuity, the beginning of the new
/// transcription may duplicate the end of the previous transcription.
///
/// # Arguments
/// * `new_text` - The newly transcribed text
/// * `previous_text` - The previous transcription to check for overlap
/// * `min_overlap_words` - Minimum words to consider as overlap (typically 2-3)
///
/// # Returns
/// The new text with overlapping prefix removed
pub fn remove_prefix_overlap(
    new_text: &str,
    previous_text: &str,
    min_overlap_words: usize,
) -> String {
    let new_words: Vec<&str> = new_text.split_whitespace().collect();
    let prev_words: Vec<&str> = previous_text.split_whitespace().collect();

    if new_words.is_empty() || prev_words.is_empty() {
        return new_text.to_string();
    }

    // Look for overlap at the end of previous_text matching start of new_text
    // Check overlaps from longest possible to min_overlap_words
    let max_overlap = new_words.len().min(prev_words.len()).min(10); // Limit to 10 words

    for overlap_len in (min_overlap_words..=max_overlap).rev() {
        let prev_suffix: Vec<String> = prev_words[prev_words.len() - overlap_len..]
            .iter()
            .map(|w| w.to_lowercase())
            .collect();
        let new_prefix: Vec<String> = new_words[..overlap_len]
            .iter()
            .map(|w| w.to_lowercase())
            .collect();

        // Check if they match (allowing for minor differences)
        if prev_suffix == new_prefix {
            debug!(
                "Removed prefix overlap ({} words): '{}'",
                overlap_len,
                new_words[..overlap_len].join(" ")
            );
            return new_words[overlap_len..].join(" ");
        }
    }

    new_text.to_string()
}

/// Collapses repeated short words (3+ repetitions) to a single instance.
/// E.g., "wh wh wh wh" -> "wh", "I I I I" -> "I", "Yeah Yeah Yeah Yeah" -> "Yeah"
fn collapse_stutters(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return text.to_string();
    }

    let mut result: Vec<&str> = Vec::new();
    let mut i = 0;

    while i < words.len() {
        let word = words[i];
        let word_lower = word.to_lowercase();

        // Process words up to 4 letters to catch common stutters like "Yeah", "what", "okay"
        if word_lower.len() <= 4 && word_lower.chars().all(|c| c.is_alphabetic()) {
            // Count consecutive repetitions (case-insensitive)
            let mut count = 1;
            while i + count < words.len() && words[i + count].to_lowercase() == word_lower {
                count += 1;
            }

            // If 3+ repetitions, collapse to single instance
            if count >= 3 {
                result.push(word);
                i += count;
            } else {
                result.push(word);
                i += 1;
            }
        } else {
            result.push(word);
            i += 1;
        }
    }

    result.join(" ")
}

/// Pre-compiled filler word patterns (built lazily)
static FILLER_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    FILLER_WORDS
        .iter()
        .map(|word| {
            // Match filler word with word boundaries, optionally followed by comma or period
            Regex::new(&format!(r"(?i)\b{}\b[,.]?", regex::escape(word))).unwrap()
        })
        .collect()
});

/// Filters transcription output by removing filler words, stutter artifacts, and hallucinations.
///
/// This function cleans up raw transcription text by:
/// 1. Detecting and rejecting hallucination patterns
/// 2. Removing filler words (uh, um, hmm, etc.)
/// 3. Collapsing repeated short word stutters (e.g., "wh wh wh" -> "wh", "Yeah Yeah Yeah" -> "Yeah")
/// 4. Cleaning up excess whitespace
///
/// # Arguments
/// * `text` - The raw transcription text to filter
///
/// # Returns
/// The filtered text with filler words, stutters, and hallucinations removed
pub fn filter_transcription_output(text: &str) -> String {
    // Early rejection of hallucinations
    if is_hallucination(text) {
        return String::new();
    }

    let mut filtered = text.to_string();

    // Remove filler words
    for pattern in FILLER_PATTERNS.iter() {
        filtered = pattern.replace_all(&filtered, "").to_string();
    }

    // Collapse repeated 1-2 letter words (stutter artifacts like "wh wh wh wh")
    filtered = collapse_stutters(&filtered);

    // Clean up multiple spaces to single space
    filtered = MULTI_SPACE_PATTERN.replace_all(&filtered, " ").to_string();

    // Trim leading/trailing whitespace
    let trimmed = filtered.trim();

    // Reject very short outputs (likely hallucinations from silent audio)
    if trimmed.len() < 2 {
        return String::new();
    }

    // Final hallucination check after processing
    if is_hallucination(trimmed) {
        return String::new();
    }

    trimmed.to_string()
}

/// Checks if two transcript segments are likely duplicates based on time overlap and text similarity.
///
/// This is used to detect when the same audio is transcribed on both mic and speaker channels
/// (e.g., due to acoustic echo). The speaker channel is considered authoritative, so this
/// function is called before adding a mic segment to check if a similar speaker segment exists.
///
/// # Arguments
/// * `new_text` - The new transcript text to check
/// * `new_start_ms` - Start time of the new segment in milliseconds
/// * `new_end_ms` - End time of the new segment in milliseconds
/// * `existing_text` - The existing transcript text to compare against
/// * `existing_start_ms` - Start time of the existing segment
/// * `existing_end_ms` - End time of the existing segment
/// * `similarity_threshold` - Minimum text similarity (0.0-1.0) to consider a duplicate (e.g., 0.75)
/// * `time_overlap_threshold_ms` - Minimum time overlap in ms to consider (e.g., 500)
///
/// # Returns
/// `true` if the segments are likely duplicates (similar text with overlapping time)
pub fn is_duplicate_segment(
    new_text: &str,
    new_start_ms: i64,
    new_end_ms: i64,
    existing_text: &str,
    existing_start_ms: i64,
    existing_end_ms: i64,
    similarity_threshold: f64,
    time_overlap_threshold_ms: i64,
) -> bool {
    // Check time overlap: max(0, min(end1, end2) - max(start1, start2))
    let overlap = (new_end_ms.min(existing_end_ms) - new_start_ms.max(existing_start_ms)).max(0);
    if overlap < time_overlap_threshold_ms {
        return false;
    }

    // Normalize text for comparison (lowercase, trimmed)
    let new_normalized = new_text.trim().to_lowercase();
    let existing_normalized = existing_text.trim().to_lowercase();

    // Skip if either text is empty
    if new_normalized.is_empty() || existing_normalized.is_empty() {
        return false;
    }

    // Calculate text similarity (0.0 = completely different, 1.0 = identical)
    let similarity = normalized_levenshtein(&new_normalized, &existing_normalized);

    if similarity >= similarity_threshold {
        debug!(
            "Duplicate segment detected: similarity={:.2}, overlap={}ms, new='{}', existing='{}'",
            similarity, overlap, new_text, existing_text
        );
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_custom_words_exact_match() {
        let text = "hello world";
        let custom_words = vec!["Hello".to_string(), "World".to_string()];
        let result = apply_custom_words(text, &custom_words, 0.5);
        assert_eq!(result, "Hello World");
    }

    #[test]
    fn test_apply_custom_words_fuzzy_match() {
        let text = "helo wrold";
        let custom_words = vec!["hello".to_string(), "world".to_string()];
        let result = apply_custom_words(text, &custom_words, 0.5);
        assert_eq!(result, "hello world");
    }

    #[test]
    fn test_preserve_case_pattern() {
        assert_eq!(preserve_case_pattern("HELLO", "world"), "WORLD");
        assert_eq!(preserve_case_pattern("Hello", "world"), "World");
        assert_eq!(preserve_case_pattern("hello", "WORLD"), "WORLD");
    }

    #[test]
    fn test_extract_punctuation() {
        assert_eq!(extract_punctuation("hello"), ("", ""));
        assert_eq!(extract_punctuation("!hello?"), ("!", "?"));
        assert_eq!(extract_punctuation("...hello..."), ("...", "..."));
    }

    #[test]
    fn test_empty_custom_words() {
        let text = "hello world";
        let custom_words = vec![];
        let result = apply_custom_words(text, &custom_words, 0.5);
        assert_eq!(result, "hello world");
    }

    #[test]
    fn test_filter_filler_words() {
        let text = "So um I was thinking uh about this";
        let result = filter_transcription_output(text);
        assert_eq!(result, "So I was thinking about this");
    }

    #[test]
    fn test_filter_filler_words_case_insensitive() {
        let text = "UM this is UH a test";
        let result = filter_transcription_output(text);
        assert_eq!(result, "this is a test");
    }

    #[test]
    fn test_filter_filler_words_with_punctuation() {
        let text = "Well, um, I think, uh. that's right";
        let result = filter_transcription_output(text);
        assert_eq!(result, "Well, I think, that's right");
    }

    #[test]
    fn test_filter_cleans_whitespace() {
        let text = "Hello    world   test";
        let result = filter_transcription_output(text);
        assert_eq!(result, "Hello world test");
    }

    #[test]
    fn test_filter_trims() {
        let text = "  Hello world  ";
        let result = filter_transcription_output(text);
        assert_eq!(result, "Hello world");
    }

    #[test]
    fn test_filter_combined() {
        let text = "  Um, so I was, uh, thinking about this  ";
        let result = filter_transcription_output(text);
        assert_eq!(result, "so I was, thinking about this");
    }

    #[test]
    fn test_filter_preserves_valid_text() {
        let text = "This is a completely normal sentence.";
        let result = filter_transcription_output(text);
        assert_eq!(result, "This is a completely normal sentence.");
    }

    #[test]
    fn test_filter_stutter_collapse() {
        let text = "w wh wh wh wh wh wh wh wh wh why";
        let result = filter_transcription_output(text);
        assert_eq!(result, "w wh why");
    }

    #[test]
    fn test_filter_stutter_short_words() {
        let text = "I I I I think so so so so";
        let result = filter_transcription_output(text);
        assert_eq!(result, "I think so");
    }

    #[test]
    fn test_filter_stutter_mixed_case() {
        let text = "No NO no NO no";
        let result = filter_transcription_output(text);
        assert_eq!(result, "No");
    }

    #[test]
    fn test_filter_stutter_preserves_two_repetitions() {
        let text = "no no is fine";
        let result = filter_transcription_output(text);
        assert_eq!(result, "no no is fine");
    }

    #[test]
    fn test_filter_stutter_four_letter_words() {
        // Test that 4-letter words like "Yeah" are now collapsed
        let text = "Yeah Yeah Yeah Yeah okay";
        let result = filter_transcription_output(text);
        assert_eq!(result, "Yeah okay");
    }

    #[test]
    fn test_filter_stutter_what() {
        // Test collapsing repeated "what"
        let text = "what what what what happened";
        let result = filter_transcription_output(text);
        assert_eq!(result, "what happened");
    }

    #[test]
    fn test_filter_stutter_well() {
        // Test collapsing repeated "well"
        let text = "well well well I think";
        let result = filter_transcription_output(text);
        assert_eq!(result, "well I think");
    }

    #[test]
    fn test_is_duplicate_segment_identical() {
        // Identical text with overlapping time should be duplicate
        assert!(is_duplicate_segment(
            "Hello world",
            1000,
            2000,
            "Hello world",
            1000,
            2000,
            0.75,
            500
        ));
    }

    #[test]
    fn test_is_duplicate_segment_similar() {
        // Similar text (minor differences) with overlapping time
        assert!(is_duplicate_segment(
            "It sounds like we're in a good spot",
            1000,
            3000,
            "It sounds like we're in a good spot, right?",
            1000,
            3000,
            0.75,
            500
        ));
    }

    #[test]
    fn test_is_duplicate_segment_different_text() {
        // Different text should not be duplicate
        assert!(!is_duplicate_segment(
            "Hello world",
            1000,
            2000,
            "Goodbye everyone",
            1000,
            2000,
            0.75,
            500
        ));
    }

    #[test]
    fn test_is_duplicate_segment_no_time_overlap() {
        // Identical text but no time overlap should not be duplicate
        assert!(!is_duplicate_segment(
            "Hello world",
            1000,
            2000,
            "Hello world",
            3000,
            4000,
            0.75,
            500
        ));
    }

    #[test]
    fn test_is_duplicate_segment_partial_overlap() {
        // Identical text with partial time overlap (>500ms) should be duplicate
        assert!(is_duplicate_segment(
            "Hello world",
            1000,
            3000,
            "Hello world",
            2000,
            4000,
            0.75,
            500
        ));
    }

    #[test]
    fn test_is_duplicate_segment_insufficient_overlap() {
        // Identical text but overlap < threshold (400ms < 500ms)
        assert!(!is_duplicate_segment(
            "Hello world",
            1000,
            2000,
            "Hello world",
            1600,
            3000,
            0.75,
            500
        ));
    }

    #[test]
    fn test_is_duplicate_segment_empty_text() {
        // Empty text should not be duplicate
        assert!(!is_duplicate_segment(
            "", 1000, 2000, "Hello", 1000, 2000, 0.75, 500
        ));
        assert!(!is_duplicate_segment(
            "Hello", 1000, 2000, "", 1000, 2000, 0.75, 500
        ));
    }

    #[test]
    fn test_is_duplicate_segment_case_insensitive() {
        // Should match case-insensitively
        assert!(is_duplicate_segment(
            "HELLO WORLD",
            1000,
            2000,
            "hello world",
            1000,
            2000,
            0.75,
            500
        ));
    }

    #[test]
    fn test_rejects_common_word_to_different_length_custom() {
        // "order" (5 chars) should NOT become "Zephyra" (7 chars)
        // Length ratio 5/7 = 0.71 < 0.8, so phonetic boost doesn't apply
        let result = apply_custom_words("we placed an order", &vec!["Zephyra".to_string()], 0.21);
        assert_eq!(result, "we placed an order");
    }

    #[test]
    fn test_rejects_argument_to_sphinx() {
        // "argument" (8 chars) should NOT become "SPHINX" (6 chars)
        // Length ratio 6/8 = 0.75 < 0.8, so phonetic boost doesn't apply
        let result = apply_custom_words("valid argument", &vec!["SPHINX".to_string()], 0.21);
        assert_eq!(result, "valid argument");
    }

    #[test]
    fn test_matches_similar_length_typo() {
        // "zefyura" (7 chars) SHOULD become "Zephyra" (7 chars)
        // Length ratio 7/7 = 1.0 > 0.8, phonetic boost applies
        let result = apply_custom_words("meeting in zefyura", &vec!["Zephyra".to_string()], 0.21);
        assert_eq!(result, "meeting in Zephyra");
    }

    #[test]
    fn test_matches_sphink_to_sphinx() {
        // "sphink" (6 chars) SHOULD become "SPHINX" (6 chars)
        // Length ratio 6/6 = 1.0 > 0.8, phonetic boost applies
        let result = apply_custom_words("the sphink system", &vec!["SPHINX".to_string()], 0.21);
        assert_eq!(result, "the SPHINX system");
    }
}
