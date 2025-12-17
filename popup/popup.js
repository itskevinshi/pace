document.addEventListener('DOMContentLoaded', async () => {
  const workAddressInput = document.getElementById('workAddress');
  const apiKeyInput = document.getElementById('apiKey');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  let autoSaveTimer = null;

  const saveDraft = async ({ immediate } = { immediate: false }) => {
    const workAddress = workAddressInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    const performSave = async () => {
      try {
        await chrome.storage.sync.set({ workAddress, apiKey });
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
    const { workAddress, apiKey } = await chrome.storage.sync.get(['workAddress', 'apiKey']);
    if (workAddress) workAddressInput.value = workAddress;
    if (apiKey) apiKeyInput.value = apiKey;
  } catch (error) {
    console.error('Error loading settings:', error);
  }

  // Auto-save on input so closing the popup doesn't lose values.
  workAddressInput.addEventListener('input', () => void saveDraft());
  apiKeyInput.addEventListener('input', () => void saveDraft());
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
      await chrome.storage.sync.set({ workAddress, apiKey });
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
