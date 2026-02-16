use futures_util::StreamExt;
use log::{debug, info, trace, warn};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Truncate a string to at most `max_bytes` while respecting UTF-8 char boundaries.
fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    // Find the largest valid char boundary <= max_bytes
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Content part for multimodal messages
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrl },
}

#[derive(Debug, Serialize, Clone)]
pub struct ImageUrl {
    pub url: String, // data:image/jpeg;base64,...
}

/// Chat message content - can be string or array of content parts
#[derive(Debug, Clone)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl Serialize for MessageContent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            MessageContent::Text(s) => serializer.serialize_str(s),
            MessageContent::Parts(parts) => parts.serialize(serializer),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: MessageContent,
}

impl ChatMessage {
    /// Create a simple text message
    pub fn text(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: MessageContent::Text(content.into()),
        }
    }

    /// Create a multimodal message with text and images
    pub fn multimodal(role: impl Into<String>, parts: Vec<ContentPart>) -> Self {
        Self {
            role: role.into(),
            content: MessageContent::Parts(parts),
        }
    }
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessageResponse,
}

#[derive(Debug, Deserialize)]
struct ChatMessageResponse {
    content: Option<String>,
}

/// Build headers for API requests (detects provider from base_url)
fn build_headers(base_url: &str, api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://github.com/itskhalil/talky"),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("Talky/1.0 (+https://github.com/itskhalil/talky)"),
    );
    headers.insert("X-Title", HeaderValue::from_static("Talky"));

    if !api_key.is_empty() {
        // Detect Anthropic from base_url
        if base_url.contains("anthropic.com") {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(api_key)
                    .map_err(|e| format!("Invalid API key header value: {}", e))?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        } else {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", api_key))
                    .map_err(|e| format!("Invalid authorization header value: {}", e))?,
            );
        }
    }

    Ok(headers)
}

/// Create an HTTP client with headers for the given base_url
fn create_client(base_url: &str, api_key: &str) -> Result<reqwest::Client, String> {
    let headers = build_headers(base_url, api_key)?;
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Send a chat completion request to an OpenAI-compatible API
/// Returns Ok(Some(content)) on success, Ok(None) if response has no content,
/// or Err on actual errors (HTTP, parsing, etc.)
pub async fn send_chat_completion(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: Vec<ChatMessage>,
) -> Result<Option<String>, String> {
    let base_url = base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    debug!("Sending chat completion request to: {}", url);

    let client = create_client(base_url, api_key)?;

    let request_body = ChatCompletionRequest {
        model: model.to_string(),
        messages,
    };

    let response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response".to_string());
        return Err(format!(
            "API request failed with status {}: {}",
            status, error_text
        ));
    }

    let completion: ChatCompletionResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse API response: {}", e))?;

    Ok(completion
        .choices
        .first()
        .and_then(|choice| choice.message.content.clone()))
}

/// Streaming chat completion request to an OpenAI-compatible API
/// Emits `enhance-notes-chunk` events for each text chunk
/// Returns the accumulated full text when complete
pub async fn stream_chat_completion(
    app: &AppHandle,
    session_id: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let base_url = base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    info!(
        "[enhance-notes] Starting stream | url={} model={} session={}",
        base_url, model, session_id
    );
    debug!("Sending streaming chat completion request to: {}", url);

    let client = create_client(base_url, api_key)?;

    let request_body = ChatCompletionRequestStream {
        model: model.to_string(),
        messages,
        stream: true,
    };

    let response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response".to_string());
        return Err(format!(
            "API request failed with status {}: {}",
            status, error_text
        ));
    }

    let mut accumulated = String::new();
    let mut stream = response.bytes_stream();

    // Buffer for incomplete SSE lines
    let mut buffer = String::new();

    let mut chunk_count = 0u32;
    let mut emit_count = 0u32;

    // Detect provider from URL for SSE parsing
    let provider_id = if base_url.contains("anthropic.com") {
        "anthropic"
    } else {
        "openai"
    };

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;
        let chunk_str = String::from_utf8_lossy(&chunk);
        buffer.push_str(&chunk_str);

        chunk_count += 1;
        trace!(
            "[enhance-notes] Raw chunk #{} | len={} preview={:?}",
            chunk_count,
            chunk_str.len(),
            truncate_str(&chunk_str, 200)
        );

        // Process complete lines from buffer
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if data.trim() == "[DONE]" {
                    // Stream complete
                    info!(
                        "[enhance-notes] Stream complete [DONE] | total_chars={} chunks_received={} chunks_emitted={}",
                        accumulated.len(),
                        chunk_count,
                        emit_count
                    );
                    debug!(
                        "[enhance-notes] Final content preview: {:?}",
                        truncate_str(&accumulated, 500)
                    );
                    let _ = app.emit(
                        "enhance-notes-chunk",
                        EnhanceNotesChunk {
                            session_id: session_id.to_string(),
                            chunk: String::new(),
                            done: true,
                        },
                    );
                    return Ok(accumulated);
                }

                // Parse JSON and extract content delta
                if let Some(content) = parse_sse_content(data, provider_id) {
                    if !content.is_empty() {
                        accumulated.push_str(&content);
                        emit_count += 1;
                        debug!(
                            "[enhance-notes] Emitting chunk #{} | len={} preview={:?}",
                            emit_count,
                            content.len(),
                            truncate_str(&content, 50)
                        );
                        let _ = app.emit(
                            "enhance-notes-chunk",
                            EnhanceNotesChunk {
                                session_id: session_id.to_string(),
                                chunk: content,
                                done: false,
                            },
                        );
                    }
                }
            }
        }
    }

    // Emit final done event if stream ended without [DONE]
    info!(
        "[enhance-notes] Stream ended (no [DONE]) | total_chars={} chunks_received={} chunks_emitted={}",
        accumulated.len(),
        chunk_count,
        emit_count
    );
    if !accumulated.is_empty() {
        debug!(
            "[enhance-notes] Final content preview: {:?}",
            truncate_str(&accumulated, 500)
        );
    }
    let _ = app.emit(
        "enhance-notes-chunk",
        EnhanceNotesChunk {
            session_id: session_id.to_string(),
            chunk: String::new(),
            done: true,
        },
    );

    Ok(accumulated)
}

/// Event payload for streaming enhanced notes chunks
#[derive(Debug, Clone, Serialize)]
pub struct EnhanceNotesChunk {
    pub session_id: String,
    pub chunk: String,
    pub done: bool,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequestStream {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
}

/// Parse SSE content from different provider formats
fn parse_sse_content(data: &str, provider_id: &str) -> Option<String> {
    let parsed: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(e) => {
            warn!(
                "[enhance-notes] JSON parse failed: {} | data={:?}",
                e,
                truncate_str(data, 200)
            );
            return None;
        }
    };

    if provider_id == "anthropic" {
        // Anthropic format: {"type":"content_block_delta","delta":{"text":"chunk"}}
        let event_type = parsed.get("type").and_then(|t| t.as_str());
        if event_type == Some("content_block_delta") {
            return parsed
                .get("delta")
                .and_then(|d| d.get("text"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
        }
        // Log unrecognized Anthropic events at trace level (many are expected like message_start)
        if event_type != Some("message_start")
            && event_type != Some("content_block_start")
            && event_type != Some("message_delta")
            && event_type != Some("message_stop")
            && event_type != Some("ping")
        {
            trace!(
                "[enhance-notes] Unrecognized Anthropic event type: {:?}",
                event_type
            );
        }
        None
    } else {
        // OpenAI format: {"choices":[{"delta":{"content":"chunk"}}]}
        let result = parsed
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        if result.is_none() {
            // Check if this is an expected non-content event (e.g., role-only delta, finish_reason)
            let has_finish_reason = parsed
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("finish_reason"))
                .is_some();
            if !has_finish_reason {
                trace!(
                    "[enhance-notes] No content in OpenAI delta: {:?}",
                    truncate_str(data, 150)
                );
            }
        }
        result
    }
}

/// Fetch available models from an OpenAI-compatible API
/// Returns a list of model IDs
pub async fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let base_url = base_url.trim_end_matches('/');
    let url = format!("{}/models", base_url);

    debug!("Fetching models from: {}", url);

    let client = create_client(base_url, api_key)?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!(
            "Model list request failed ({}): {}",
            status, error_text
        ));
    }

    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mut models = Vec::new();

    // Handle OpenAI format: { data: [ { id: "..." }, ... ] }
    if let Some(data) = parsed.get("data").and_then(|d| d.as_array()) {
        for entry in data {
            if let Some(id) = entry.get("id").and_then(|i| i.as_str()) {
                models.push(id.to_string());
            } else if let Some(name) = entry.get("name").and_then(|n| n.as_str()) {
                models.push(name.to_string());
            }
        }
    }
    // Handle array format: [ "model1", "model2", ... ]
    else if let Some(array) = parsed.as_array() {
        for entry in array {
            if let Some(model) = entry.as_str() {
                models.push(model.to_string());
            }
        }
    }

    Ok(models)
}
