//! Keeps the macOS typing helpers out of Kubepit's text fields.
//!
//! Autocorrect (the "fir" → "Fir" bubble), capitalisation, completions,
//! inline predictions, substitutions and spell check all rewrite resource
//! names, selectors and YAML. WebKit's text checker reads the `Web*` keys
//! from the app's user defaults when the first webview is created, so this
//! runs before the Tauri builder opens any window. The `NS*` keys cover
//! `NSSpellChecker`, which WebKit falls back to and re-reads when the system
//! setting changes.
//!
//! Only the app's own defaults domain is written; the system-wide settings
//! stay the user's. They are rewritten on every launch, so an in-session
//! toggle cannot outlive a restart. The frontend half is
//! `src/lib/textInputGuard.ts`.

#[cfg(target_os = "macos")]
pub(crate) fn disable_os_typing_helpers() {
    use objc2_foundation::{ns_string, NSUserDefaults};

    let defaults = NSUserDefaults::standardUserDefaults();
    for key in [
        // WebKit (WKWebView).
        ns_string!("WebAutomaticSpellingCorrectionEnabled"),
        ns_string!("WebContinuousSpellCheckingEnabled"),
        ns_string!("WebGrammarCheckingEnabled"),
        ns_string!("WebAutomaticTextReplacementEnabled"),
        ns_string!("WebAutomaticQuoteSubstitutionEnabled"),
        ns_string!("WebAutomaticDashSubstitutionEnabled"),
        ns_string!("WebAutomaticLinkDetectionEnabled"),
        // AppKit (NSSpellChecker).
        ns_string!("NSAutomaticSpellingCorrectionEnabled"),
        ns_string!("NSAutomaticCapitalizationEnabled"),
        ns_string!("NSAutomaticTextCompletionEnabled"),
        ns_string!("NSAutomaticInlinePredictionEnabled"),
        ns_string!("NSAutomaticPeriodSubstitutionEnabled"),
        ns_string!("NSAutomaticQuoteSubstitutionEnabled"),
        ns_string!("NSAutomaticDashSubstitutionEnabled"),
    ] {
        defaults.setBool_forKey(false, key);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn disable_os_typing_helpers() {}
