document.addEventListener('DOMContentLoaded', async () => {
  const workAddressInput = document.getElementById('workAddress');
  const autocompleteResults = document.getElementById('autocomplete-results');
  const apiKeyInput = document.getElementById('apiKey');
  const debugModeInput = document.getElementById('debugMode');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  console.log('[Pace] Popup initialized. Elements:', {
    workAddressInput: !!workAddressInput,
    apiKeyInput: !!apiKeyInput,
    saveBtn: !!saveBtn
  });

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
        // Silent: autosave should never block normal usage.
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
    }, 400);
  };

  // Load existing settings
  try {
    const { workAddress, apiKey, debugMode, workCoords } = await chrome.storage.sync.get(['workAddress', 'apiKey', 'debugMode', 'workCoords']);
    if (workAddress) workAddressInput.value = workAddress;
    if (apiKey) apiKeyInput.value = apiKey;
    if (debugMode !== undefined) debugModeInput.checked = debugMode;
    if (workCoords) selectedCoords = workCoords;
  } catch (error) {
    console.error('Error loading settings:', error);
  }

  // Autocomplete logic
  workAddressInput.addEventListener('input', () => {
    const query = workAddressInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (autocompleteTimer) clearTimeout(autocompleteTimer);
    
    // Clear results if query is too short
    if (query.length < 3) {
      autocompleteResults.style.display = 'none';
      return;
    }

    // If no API key, we can't do autocomplete
    if (!apiKey) {
      console.warn('[Pace] Cannot autocomplete: No API key entered');
      autocompleteResults.style.display = 'none';
      return;
    }

    autocompleteTimer = setTimeout(async () => {
      try {
        console.log('[Pace] Fetching autocomplete for:', query);
        const params = new URLSearchParams({
          text: query,
          apiKey: apiKey,
          limit: 5,
          filter: 'countrycode:us',
          bias: 'proximity:-73.968285,40.785091' // Bias towards NYC
        });
        const response = await fetch(`https://api.geoapify.com/v1/geocode/autocomplete?${params}`);
        
        if (!response.ok) {
          const errorData = await response.json();
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
    }, 300);
  });

  // Close autocomplete when clicking outside
  document.addEventListener('click', (e) => {
    if (!workAddressInput.contains(e.target) && !autocompleteResults.contains(e.target)) {
      autocompleteResults.style.display = 'none';
    }
  });

  // Auto-save on input so closing the popup doesn't lose values.
  workAddressInput.addEventListener('input', () => void saveDraft());
  apiKeyInput.addEventListener('input', () => {
    void saveDraft();
    // If user just pasted API key, trigger autocomplete if address is already typed
    if (workAddressInput.value.trim().length >= 3) {
      workAddressInput.dispatchEvent(new Event('input'));
    }
  });
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

    console.log('[Pace] Save clicked. Work Address:', workAddress, 'API Key:', apiKey ? 'PRESENT' : 'MISSING');

    // Validation
    if (!workAddress) {
      showStatus('Please enter your work address', 'error');
      return;
    }

    if (!apiKey) {
      showStatus('Please enter your Geoapify API key', 'error');
      return;
    }

    if (apiKey.length < 20) {
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
