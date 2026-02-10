use crate::settings::{
    get_settings, write_settings, FontSize, LLMPrompt, ModelEnvironment, WordSuggestion,
};
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
pub fn change_speaker_energy_threshold_setting(
    app: AppHandle,
    threshold: f32,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    // Clamp to valid range: 0.001 to 0.5
    settings.speaker_energy_threshold = threshold.clamp(0.001, 0.5);
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_skip_mic_on_speaker_energy_setting(
    app: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.skip_mic_on_speaker_energy = enabled;
    write_settings(&app, settings);
    Ok(())
}

// Model Environment Commands
#[tauri::command]
#[specta::specta]
pub fn get_environments(app: AppHandle) -> Vec<ModelEnvironment> {
    let settings = get_settings(&app);
    settings.model_environments
}

#[tauri::command]
#[specta::specta]
pub fn create_environment(
    app: AppHandle,
    name: String,
    color: String,
    base_url: String,
    api_key: String,
    summarisation_model: String,
    chat_model: String,
) -> Result<ModelEnvironment, String> {
    let mut settings = get_settings(&app);

    // Check max environments limit (3)
    if settings.model_environments.len() >= 3 {
        return Err("Maximum of 3 environments allowed".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let new_env = ModelEnvironment {
        id: id.clone(),
        name,
        color,
        base_url,
        api_key,
        summarisation_model,
        chat_model,
        model: String::new(), // Deprecated, kept for migration compatibility
    };

    settings.model_environments.push(new_env.clone());

    // If this is the first environment, set it as default
    if settings.model_environments.len() == 1 {
        settings.default_environment_id = Some(id);
    }

    write_settings(&app, settings);
    Ok(new_env)
}

#[tauri::command]
#[specta::specta]
pub fn update_environment(
    app: AppHandle,
    id: String,
    name: Option<String>,
    color: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    summarisation_model: Option<String>,
    chat_model: Option<String>,
) -> Result<ModelEnvironment, String> {
    let mut settings = get_settings(&app);

    let env = settings
        .get_environment_mut(&id)
        .ok_or_else(|| format!("Environment not found: {}", id))?;

    if let Some(n) = name {
        env.name = n;
    }
    if let Some(c) = color {
        env.color = c;
    }
    if let Some(url) = base_url {
        env.base_url = url;
    }
    if let Some(key) = api_key {
        env.api_key = key;
    }
    if let Some(m) = summarisation_model {
        env.summarisation_model = m;
    }
    if let Some(m) = chat_model {
        env.chat_model = m;
    }

    let updated_env = env.clone();
    write_settings(&app, settings);
    Ok(updated_env)
}

#[tauri::command]
#[specta::specta]
pub fn delete_environment(app: AppHandle, id: String) -> Result<(), String> {
    let mut settings = get_settings(&app);

    // Must keep at least 1 environment
    if settings.model_environments.len() <= 1 {
        return Err("Cannot delete the last environment".to_string());
    }

    let original_len = settings.model_environments.len();
    settings.model_environments.retain(|e| e.id != id);

    if settings.model_environments.len() < original_len {
        // If deleted environment was the default, set first remaining as default
        if settings.default_environment_id.as_ref() == Some(&id) {
            settings.default_environment_id =
                settings.model_environments.first().map(|e| e.id.clone());
        }
        write_settings(&app, settings);
        Ok(())
    } else {
        Err(format!("Environment not found: {}", id))
    }
}

#[tauri::command]
#[specta::specta]
pub fn set_default_environment(app: AppHandle, id: String) -> Result<(), String> {
    let mut settings = get_settings(&app);

    // Verify the environment exists
    if !settings.model_environments.iter().any(|e| e.id == id) {
        return Err(format!("Environment not found: {}", id));
    }

    settings.default_environment_id = Some(id);
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn fetch_environment_models(
    app: AppHandle,
    environment_id: String,
) -> Result<Vec<String>, String> {
    let settings = get_settings(&app);

    let env = settings
        .get_environment(&environment_id)
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    crate::llm_client::fetch_models(&env.base_url, &env.api_key).await
}
