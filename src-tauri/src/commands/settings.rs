use crate::settings::{get_settings, write_settings, FontSize, LLMPrompt, WordSuggestion};
use crate::tray::update_tray_menu;
use crate::utils::TrayIconState;
use log::info;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
#[specta::specta]
pub fn change_font_size_setting(app: AppHandle, size: FontSize) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.font_size = size;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_start_hidden_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.start_hidden = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_autostart_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.autostart_enabled = enabled;
    write_settings(&app, settings);

    let autostart_manager = app.autolaunch();
    if enabled {
        let _ = autostart_manager.enable();
    } else {
        let _ = autostart_manager.disable();
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_translate_to_english_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.translate_to_english = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_selected_language_setting(app: AppHandle, language: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.selected_language = language;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_debug_mode_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.debug_mode = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_post_process_enabled_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.post_process_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_experimental_enabled_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.experimental_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_post_process_base_url_setting(
    app: AppHandle,
    provider_id: String,
    base_url: String,
) -> Result<(), String> {
    let mut settings = get_settings(&app);

    if let Some(provider) = settings.post_process_provider_mut(&provider_id) {
        provider.base_url = base_url;
        write_settings(&app, settings);
        Ok(())
    } else {
        Err(format!("Provider not found: {}", provider_id))
    }
}

#[tauri::command]
#[specta::specta]
pub fn change_post_process_api_key_setting(
    app: AppHandle,
    provider_id: String,
    api_key: String,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.post_process_api_keys.insert(provider_id, api_key);
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_post_process_model_setting(
    app: AppHandle,
    provider_id: String,
    model: String,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.post_process_models.insert(provider_id, model);
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_post_process_provider(app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.post_process_provider_id = provider_id;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn fetch_post_process_models(
    app: AppHandle,
    provider_id: String,
) -> Result<Vec<String>, String> {
    let settings = get_settings(&app);

    let provider = settings
        .post_process_provider(&provider_id)
        .ok_or_else(|| format!("Provider not found: {}", provider_id))?;

    let api_key = settings
        .post_process_api_keys
        .get(&provider_id)
        .cloned()
        .unwrap_or_default();

    crate::llm_client::fetch_models(provider, api_key).await
}

#[tauri::command]
#[specta::specta]
pub fn add_post_process_prompt(
    app: AppHandle,
    name: String,
    prompt: String,
) -> Result<LLMPrompt, String> {
    let mut settings = get_settings(&app);
    let id = uuid::Uuid::new_v4().to_string();
    let new_prompt = LLMPrompt {
        id: id.clone(),
        name,
        prompt,
    };
    settings.post_process_prompts.push(new_prompt.clone());
    write_settings(&app, settings);
    Ok(new_prompt)
}

#[tauri::command]
#[specta::specta]
pub fn update_post_process_prompt(
    app: AppHandle,
    id: String,
    name: String,
    prompt: String,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    if let Some(existing) = settings
        .post_process_prompts
        .iter_mut()
        .find(|p| p.id == id)
    {
        existing.name = name;
        existing.prompt = prompt;
        write_settings(&app, settings);
        Ok(())
    } else {
        Err(format!("Prompt not found: {}", id))
    }
}

#[tauri::command]
#[specta::specta]
pub fn delete_post_process_prompt(app: AppHandle, id: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    let original_len = settings.post_process_prompts.len();
    settings.post_process_prompts.retain(|p| p.id != id);

    if settings.post_process_prompts.len() < original_len {
        // If the deleted prompt was selected, clear the selection
        if settings.post_process_selected_prompt_id.as_ref() == Some(&id) {
            settings.post_process_selected_prompt_id = None;
        }
        write_settings(&app, settings);
        Ok(())
    } else {
        Err(format!("Prompt not found: {}", id))
    }
}

#[tauri::command]
#[specta::specta]
pub fn set_post_process_selected_prompt(app: AppHandle, id: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.post_process_selected_prompt_id = if id.is_empty() { None } else { Some(id) };
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn update_custom_words(app: AppHandle, words: Vec<String>) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.custom_words = words;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_app_language_setting(app: AppHandle, language: String) -> Result<(), String> {
    info!("Changing app language to: {}", language);
    let mut settings = get_settings(&app);
    settings.app_language = language.clone();
    write_settings(&app, settings);

    // Update tray menu with new locale
    update_tray_menu(&app, &TrayIconState::Idle, Some(&language));

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_update_checks_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.update_checks_enabled = enabled;
    write_settings(&app, settings);

    // Update tray menu to enable/disable the check for updates item
    update_tray_menu(&app, &TrayIconState::Idle, None);

    Ok(())
}

// Chat settings
#[tauri::command]
#[specta::specta]
pub fn set_chat_provider(app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.chat_provider_id = provider_id;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_chat_model_setting(
    app: AppHandle,
    provider_id: String,
    model: String,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.chat_models.insert(provider_id, model);
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn fetch_chat_models(app: AppHandle, provider_id: String) -> Result<Vec<String>, String> {
    let settings = get_settings(&app);

    let provider = settings
        .post_process_provider(&provider_id)
        .ok_or_else(|| format!("Provider not found: {}", provider_id))?;

    // Use the same API key as post-processing for consistency
    let api_key = settings
        .post_process_api_keys
        .get(&provider_id)
        .cloned()
        .unwrap_or_default();

    crate::llm_client::fetch_models(provider, api_key).await
}

#[tauri::command]
#[specta::specta]
pub fn change_copy_as_bullets_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.copy_as_bullets_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}

// Word Suggestions
#[tauri::command]
#[specta::specta]
pub fn get_word_suggestions(app: AppHandle) -> Vec<WordSuggestion> {
    let settings = get_settings(&app);
    settings.word_suggestions
}

#[tauri::command]
#[specta::specta]
pub fn approve_word_suggestion(app: AppHandle, word: String) -> Result<(), String> {
    let mut settings = get_settings(&app);

    // Add to custom words if not already present
    if !settings.custom_words.contains(&word) {
        settings.custom_words.push(word.clone());
    }

    // Remove from suggestions
    settings.word_suggestions.retain(|s| s.word != word);

    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn dismiss_word_suggestion(app: AppHandle, word: String) -> Result<(), String> {
    let mut settings = get_settings(&app);

    // Add to dismissed list to prevent re-suggesting
    if !settings.dismissed_suggestions.contains(&word) {
        settings.dismissed_suggestions.push(word.clone());
    }

    // Remove from suggestions
    settings.word_suggestions.retain(|s| s.word != word);

    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn add_word_suggestion(
    app: AppHandle,
    word: String,
    session_title: String,
    session_id: String,
) -> Result<(), String> {
    let mut settings = get_settings(&app);

    // Skip if already in custom words, dismissed, or suggestions
    if settings.custom_words.contains(&word)
        || settings.dismissed_suggestions.contains(&word)
        || settings.word_suggestions.iter().any(|s| s.word == word)
    {
        return Ok(());
    }

    // Add new suggestion
    settings.word_suggestions.push(WordSuggestion {
        word,
        source_session_title: session_title,
        source_session_id: session_id,
    });

    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_word_suggestions_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.word_suggestions_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_speaker_energy_threshold_setting(app: AppHandle, threshold: f32) -> Result<(), String> {
    let mut settings = get_settings(&app);
    // Clamp to valid range: 0.001 to 0.5
    settings.speaker_energy_threshold = threshold.clamp(0.001, 0.5);
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_skip_mic_on_speaker_energy_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.skip_mic_on_speaker_energy = enabled;
    write_settings(&app, settings);
    Ok(())
}
