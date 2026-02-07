// Pace - Service Worker
// Uses the user's own Geoapify key when available, otherwise falls back to
// the shared Cloudflare Worker proxy.

// ============================================
// Install Tracking (Google Forms)
// ============================================
const INSTALL_TRACKING = {
  formId: '1FAIpQLSfIly4U6mOC3jZW5hdgtFgIG-9MIq0ceLcSKI77zPoZXrUEZg',
  entryId: 'entry.466641828',
};

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;

  const { installReported } = await chrome.storage.local.get('installReported');
  if (installReported) return;

  const installId = crypto.randomUUID();
  const formUrl = `https://docs.google.com/forms/d/e/${INSTALL_TRACKING.formId}/formResponse`;
  const formData = new URLSearchParams();
  formData.append(INSTALL_TRACKING.entryId, installId);

  try {
    await fetch(formUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });
    await chrome.storage.local.set({ installReported: true, installId });
    console.log('[Pace] Install tracked:', installId);
    setUninstallUrl(installId);
  } catch (err) {
    console.error('[Pace] Failed to track install:', err);
  }
});

// ============================================================================
// Constants
// ============================================================================

/** NYC center coordinates for geocoding bias. Also used in popup/popup.js */
const NYC_CENTER = { lat: 40.785091, lon: -73.968285 };

/** Geoapify API base URLs (used when the user provides their own key) */
const GEOAPIFY_GEOCODE_URL = 'https://api.geoapify.com/v1/geocode/search';
const GEOAPIFY_ROUTING_URL = 'https://api.geoapify.com/v1/routing';

/**
 * Shared Cloudflare Worker proxy (used when no user key is configured).
 * TODO: Replace with your deployed worker URL after running `wrangler deploy`.
 */
const WORKER_BASE_URL = 'https://pace-api.kevinshi0.workers.dev';

// ============================================
// Uninstall Tracking
// ============================================

function setUninstallUrl(installId) {
  if (!installId) return;
  const url = `${WORKER_BASE_URL}/uninstall?id=${encodeURIComponent(installId)}`;
  chrome.runtime.setUninstallURL(url, () => {
    if (chrome.runtime.lastError) {
      console.error('[Pace] Failed to set uninstall URL:', chrome.runtime.lastError.message);
    } else {
      console.log('[Pace] Uninstall URL set');
    }
  });
}

// Re-set uninstall URL on every service worker startup (covers worker restarts)
chrome.storage.local.get('installId').then(({ installId }) => {
  if (installId) setUninstallUrl(installId);
});

// ============================================================================
// Message Handler
// ============================================================================

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_COMMUTE_TIMES') {
    handleCommuteRequest(request.apartmentAddress)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
});

/**
 * Handles a commute time request from the content script.
 * Geocodes addresses and calculates transit route.
 * @param {string} apartmentAddress - The apartment address to calculate commute from
 * @returns {Promise<Object>} Result with morning/evening times, coordinates, and formatted addresses
 * @throws {Error} If work address not configured or geocoding fails
 */
async function handleCommuteRequest(apartmentAddress) {
  // Get stored settings
  const { workAddress, apiKey, debugMode, workCoords } = await chrome.storage.sync.get(['workAddress', 'apiKey', 'debugMode', 'workCoords']);
  const debugInfo = debugMode ? { steps: [] } : null;

  if (debugInfo) {
    debugInfo.steps.push({
      step: 'Input Addresses',
      apartmentAddress,
      workAddress,
      hasStoredWorkCoords: !!workCoords,
      mode: apiKey ? 'direct (user key)' : 'proxy (shared worker)',
    });
  }

  if (!workAddress) {
    throw new Error('Please set your work address in the Pace extension popup.');
  }

  // Geocode both addresses to get coordinates
  // If we have stored work coordinates, use them directly
  const [apartmentCoords, finalWorkCoords] = await Promise.all([
    geocodeAddress(apartmentAddress, apiKey, debugInfo, 'Apartment'),
    workCoords ? Promise.resolve(workCoords) : geocodeAddress(workAddress, apiKey, debugInfo, 'Work')
  ]);

  if (!apartmentCoords) {
    throw new Error('Could not find the apartment location. Try a more specific address.');
  }

  if (!finalWorkCoords) {
    throw new Error('Could not find your work location. Check the address in settings.');
  }

  // Get transit route (Geoapify returns average transit time)
  const routeResult = await fetchTransitRoute(apartmentCoords, finalWorkCoords, apiKey, debugInfo);

  // Return same time for both directions (transit is roughly symmetric)
  return {
    morning: routeResult,
    evening: routeResult,
    apartmentCoords,
    workCoords: finalWorkCoords,
    apartmentFormatted: apartmentCoords.formatted,
    workFormatted: finalWorkCoords.formatted || workAddress,
    debug: debugInfo
  };
}

/**
 * Builds the geocode URL based on whether the user has their own API key.
 * With a key → direct Geoapify call. Without → shared worker proxy.
 */
function buildGeocodeUrl(address, apiKey) {
  const shared = {
    text: address,
    limit: 1,
    filter: 'countrycode:us',
    bias: `proximity:${NYC_CENTER.lon},${NYC_CENTER.lat}`,
  };

  if (apiKey) {
    const params = new URLSearchParams({ ...shared, apiKey });
    return `${GEOAPIFY_GEOCODE_URL}?${params}`;
  }

  const params = new URLSearchParams(shared);
  return `${WORKER_BASE_URL}/geocode?${params}`;
}

/**
 * Builds the routing URL based on whether the user has their own API key.
 */
function buildRoutingUrl(waypoints, apiKey) {
  const shared = { waypoints, mode: 'transit' };

  if (apiKey) {
    const params = new URLSearchParams({ ...shared, apiKey });
    return `${GEOAPIFY_ROUTING_URL}?${params}`;
  }

  const params = new URLSearchParams(shared);
  return `${WORKER_BASE_URL}/route?${params}`;
}

/**
 * Geocodes an address to coordinates.
 * Uses the user's API key directly if available, otherwise the shared worker proxy.
 * @param {string} address - The address to geocode
 * @param {string|undefined} apiKey - User's Geoapify API key (optional)
 * @param {Object|null} debugInfo - Debug info object to append steps to
 * @param {string} label - Label for debug logging (e.g., 'Apartment', 'Work')
 * @returns {Promise<{lat: number, lon: number, formatted: string}|null>} Coordinates or null
 */
async function geocodeAddress(address, apiKey, debugInfo, label) {
  const url = buildGeocodeUrl(address, apiKey);

  if (debugInfo) {
    const safeUrl = apiKey ? url.replace(apiKey, 'REDACTED') : url;
    debugInfo.steps.push({ step: `Geocoding ${label}`, url: safeUrl });
  }

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    if (debugInfo) {
      debugInfo.steps.push({ step: `Geocoding ${label} Network Error`, error: error.message });
    }
    throw new Error('Network error - please check your internet connection.');
  }

  if (response.status === 429) {
    throw new Error(
      'Daily API limit reached. You can add your own free Geoapify API key in Pace advanced settings to continue.'
    );
  }

  if (!response.ok) {
    if (debugInfo) {
      debugInfo.steps.push({ step: `Geocoding ${label} HTTP Error`, status: response.status });
    }
    if (response.status === 401) {
      throw new Error(apiKey
        ? 'Invalid API key. Please check your key in Pace advanced settings.'
        : 'Service authentication error. Please try again later.'
      );
    }
    throw new Error('Geocoding service error. Please try again.');
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (debugInfo) {
      debugInfo.steps.push({ step: `Geocoding ${label} Parse Error`, error: error.message });
    }
    throw new Error('Invalid response from geocoding service.');
  }

  if (data.features && data.features.length > 0) {
    const coords = data.features[0].geometry.coordinates;
    const properties = data.features[0].properties;
    const result = {
      lat: coords[1],
      lon: coords[0],
      formatted: properties.formatted
    };
    if (debugInfo) {
      debugInfo.steps.push({ step: `Geocoding ${label} Success`, result, raw: properties });
    }
    return result;
  }

  if (debugInfo) {
    debugInfo.steps.push({ step: `Geocoding ${label} Failed`, address });
  }
  return null;
}

/**
 * Fetches transit route between two coordinates.
 * Uses the user's API key directly if available, otherwise the shared worker proxy.
 * @param {{lat: number, lon: number, formatted: string}} from - Origin coordinates
 * @param {{lat: number, lon: number, formatted: string}} to - Destination coordinates
 * @param {string|undefined} apiKey - User's Geoapify API key (optional)
 * @param {Object|null} debugInfo - Debug info object to append steps to
 * @returns {Promise<{text: string, minutes: number|null}>} Route duration
 */
async function fetchTransitRoute(from, to, apiKey, debugInfo) {
  const waypoints = `${from.lat},${from.lon}|${to.lat},${to.lon}`;
  const url = buildRoutingUrl(waypoints, apiKey);

  if (debugInfo) {
    const safeUrl = apiKey ? url.replace(apiKey, 'REDACTED') : url;
    debugInfo.steps.push({ step: 'Routing API Request', url: safeUrl });
  }

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    if (debugInfo) {
      debugInfo.steps.push({ step: 'Routing Network Error', error: error.message });
    }
    throw new Error('Network error - please check your internet connection.');
  }

  // Try to parse JSON - Geoapify returns JSON even for error responses
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    if (debugInfo) {
      debugInfo.steps.push({ step: 'Routing Parse Error', error: error.message, status: response.status });
    }
    if (!response.ok) {
      throw new Error(`Routing service error (${response.status}). Please try again.`);
    }
    throw new Error('Invalid response from routing service.');
  }

  // Log full response for debugging (only when debug mode is enabled)
  if (debugInfo && (!response.ok || data?.error || !data?.features?.length)) {
    console.warn('[Pace Service Worker] Routing API issue:', {
      status: response.status,
      statusText: response.statusText,
      waypoints,
      fromFormatted: from.formatted,
      toFormatted: to.formatted,
      fromCoords: { lat: from.lat, lon: from.lon },
      toCoords: { lat: to.lat, lon: to.lon },
      fullResponse: data
    });
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        'Daily API limit reached. You can add your own free Geoapify API key in Pace advanced settings to continue.'
      );
    }
    if (response.status === 401) {
      throw new Error(apiKey
        ? 'Invalid API key. Please check your key in Pace advanced settings.'
        : 'Service authentication error. Please try again later.'
      );
    }
    if (response.status === 400) {
      if (debugInfo) {
        const errorDetail = data?.message || data?.error?.message || '';
        console.warn('[Pace] Transit route 400 error detail:', errorDetail);
      }
      throw new Error('No transit route available for this address');
    }
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  if (data?.error || data?.statusCode === 400) {
    const errorMsg = data?.message || data?.error?.message || data?.error;
    if (debugInfo) debugInfo.steps.push({ step: 'Routing API Error', error: data });

    if (errorMsg?.includes('distance exceeds') || errorMsg?.includes('max distance')) {
      throw new Error('Address geocoded to wrong location (not in NYC area)');
    }
    if (errorMsg?.includes('No path') || errorMsg?.includes('could not be found')) {
      throw new Error('No transit route available');
    }
    throw new Error(errorMsg || 'Routing failed');
  }

  if (!data?.features || data.features.length === 0) {
    if (debugInfo) debugInfo.steps.push({ step: 'Routing API No Results', data });
    return { text: 'No transit route', minutes: null };
  }

  const route = data.features[0];
  const properties = route.properties;

  if (!properties || !properties.time) {
    if (debugInfo) debugInfo.steps.push({ step: 'Routing API No Time Property', properties });
    return { text: 'No transit route', minutes: null };
  }

  const totalMinutes = Math.round(properties.time / 60);

  if (debugInfo) {
    debugInfo.steps.push({ step: 'Routing API Success', minutes: totalMinutes, properties });
  }

  return {
    text: formatDuration(totalMinutes),
    minutes: totalMinutes
  };
}

function formatDuration(minutes) {
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (mins === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${mins} min`;
}
