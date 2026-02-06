// ============================================================================
// Constants
// ============================================================================

/** NYC center coordinates for geocoding bias. Also used in background/service-worker.js */
const NYC_CENTER = { lat: 40.785091, lon: -73.968285 };

/** Geoapify autocomplete API URL (used when the user provides their own key) */
const GEOAPIFY_AUTOCOMPLETE_URL = 'https://api.geoapify.com/v1/geocode/autocomplete';

/**
 * Shared Cloudflare Worker proxy (used when no user key is configured).
 * Must match the WORKER_BASE_URL in background/service-worker.js.
 */
const WORKER_BASE_URL = 'https://pace-api.kevinshi0.workers.dev';

/** Debounce delay for autocomplete requests (ms) */
const AUTOCOMPLETE_DEBOUNCE_MS = 300;

/** Debounce delay for auto-save (ms) */
const AUTOSAVE_DEBOUNCE_MS = 400;

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  const workAddressInput = document.getElementById('workAddress');
  const autocompleteResults = document.getElementById('autocomplete-results');
  const apiKeyInput = document.getElementById('apiKey');
  const debugModeInput = document.getElementById('debugMode');
  const advancedSettings = document.getElementById('advancedSettings');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  console.log('[Pace] Popup initialized.');

  let autoSaveTimer = null;
  let autocompleteTimer = null;
  let selectedCoords = null;

  const saveDraft = async ({ immediate } = { immediate: false }) => {
    const workAddress = workAddressInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const debugMode = debugModeInput.checked;

    const performSave = async () => {
      try {
        const data = { workAddress, apiKey, debugMode };
        if (selectedCoords) {
          data.workCoords = selectedCoords;
        }
        await chrome.storage.sync.set(data);
      } catch (error) {
        console.error('Error auto-saving settings:', error);
      }
    };

    if (immediate) {
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      await performSave();
      return;
    }

    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      void performSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  // Load existing settings
  try {
    const { workAddress, apiKey, debugMode, workCoords } = await chrome.storage.sync.get(['workAddress', 'apiKey', 'debugMode', 'workCoords']);
    if (workAddress) workAddressInput.value = workAddress;
    if (apiKey) {
      apiKeyInput.value = apiKey;
      // Auto-open advanced settings if user already has a key configured
      advancedSettings.open = true;
    }
    if (debugMode !== undefined) debugModeInput.checked = debugMode;
    if (debugMode) advancedSettings.open = true;
    if (workCoords) selectedCoords = workCoords;
  } catch (error) {
    console.error('Error loading settings:', error);
  }

  /**
   * Builds the autocomplete URL.
   * If the user has their own API key, call Geoapify directly.
   * Otherwise, use the shared worker proxy.
   */
  function buildAutocompleteUrl(query, apiKey) {
    const shared = {
      text: query,
      limit: 5,
      filter: 'countrycode:us',
      bias: `proximity:${NYC_CENTER.lon},${NYC_CENTER.lat}`,
    };

    if (apiKey) {
      const params = new URLSearchParams({ ...shared, apiKey });
      return `${GEOAPIFY_AUTOCOMPLETE_URL}?${params}`;
    }

    const params = new URLSearchParams(shared);
    return `${WORKER_BASE_URL}/autocomplete?${params}`;
  }

  // Autocomplete logic
  workAddressInput.addEventListener('input', () => {
    const query = workAddressInput.value.trim();

    if (autocompleteTimer) clearTimeout(autocompleteTimer);

    if (query.length < 3) {
      autocompleteResults.style.display = 'none';
      return;
    }

    autocompleteTimer = setTimeout(async () => {
      try {
        const apiKey = apiKeyInput.value.trim();
        const url = buildAutocompleteUrl(query, apiKey);
        console.log('[Pace] Fetching autocomplete for:', query);

        const response = await fetch(url);

        if (response.status === 429) {
          console.warn('[Pace] Autocomplete rate limited');
          return;
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error('[Pace] Autocomplete API error:', errorData);
          return;
        }

        const data = await response.json();
        console.log('[Pace] Autocomplete results:', data);

        if (data.features && data.features.length > 0) {
          autocompleteResults.innerHTML = '';
          data.features.forEach(feature => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            const props = feature.properties;

            item.innerHTML = `
              <span class="main-text">${props.address_line1}</span>
              <span class="secondary-text">${props.address_line2}</span>
            `;

            item.addEventListener('click', () => {
              workAddressInput.value = props.formatted;
              selectedCoords = {
                lat: feature.geometry.coordinates[1],
                lon: feature.geometry.coordinates[0]
              };
              autocompleteResults.style.display = 'none';
              void saveDraft({ immediate: true });
            });
            autocompleteResults.appendChild(item);
          });
          autocompleteResults.style.display = 'block';
        } else {
          autocompleteResults.style.display = 'none';
        }
      } catch (error) {
        console.error('Autocomplete error:', error);
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  });

  // Close autocomplete when clicking outside
  document.addEventListener('click', (e) => {
    if (!workAddressInput.contains(e.target) && !autocompleteResults.contains(e.target)) {
      autocompleteResults.style.display = 'none';
    }
  });

  // Auto-save on input so closing the popup doesn't lose values.
  workAddressInput.addEventListener('input', () => void saveDraft());
  apiKeyInput.addEventListener('input', () => void saveDraft());
  debugModeInput.addEventListener('change', () => void saveDraft({ immediate: true }));
  // Save immediately on change (blur) to be extra reliable.
  workAddressInput.addEventListener('change', () => void saveDraft({ immediate: true }));
  apiKeyInput.addEventListener('change', () => void saveDraft({ immediate: true }));
  // Try to flush when the popup is being closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void saveDraft({ immediate: true });
    }
  });

  // Save handler
  saveBtn.addEventListener('click', async () => {
    const workAddress = workAddressInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const debugMode = debugModeInput.checked;

    console.log('[Pace] Save clicked. Work Address:', workAddress, 'API Key:', apiKey ? 'PRESENT' : 'using shared');

    if (!workAddress) {
      showStatus('Please enter your work address', 'error');
      return;
    }

    // Only validate API key length if one was provided
    if (apiKey && apiKey.length < 20) {
      showStatus('API key seems too short. Please check it.', 'error');
      return;
    }

    try {
      const data = { workAddress, apiKey, debugMode };
      if (selectedCoords) {
        data.workCoords = selectedCoords;
      }
      await chrome.storage.sync.set(data);
      showStatus('Settings saved! Refresh any StreetEasy page to see commute times.', 'success');
    } catch (error) {
      console.error('Error saving settings:', error);
      showStatus('Failed to save settings. Please try again.', 'error');
    }
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;

    if (type === 'success') {
      setTimeout(() => {
        statusDiv.className = 'status';
      }, 5000);
    }
  }
});
