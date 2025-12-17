// Pace - Service Worker using Geoapify API (free, no credit card required)

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_COMMUTE_TIMES') {
    handleCommuteRequest(request.apartmentAddress)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function handleCommuteRequest(apartmentAddress) {
  // Get stored settings
  const { workAddress, apiKey, debugMode, workCoords } = await chrome.storage.sync.get(['workAddress', 'apiKey', 'debugMode', 'workCoords']);
  const debugInfo = debugMode ? { steps: [] } : null;

  if (debugInfo) {
    debugInfo.steps.push({ step: 'Input Addresses', apartmentAddress, workAddress, hasStoredWorkCoords: !!workCoords });
  }

  if (!workAddress) {
    throw new Error('Please set your work address in the Pace extension popup.');
  }

  if (!apiKey) {
    throw new Error('Please set your Geoapify API key in the Pace extension popup.');
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
  // We calculate one route since transit times are averaged
  const routeResult = await fetchTransitRoute(apartmentCoords, finalWorkCoords, apiKey, debugInfo);

  // Return same time for both directions (transit is roughly symmetric)
  // Note: Geoapify transit gives average times, not time-specific
  return {
    morning: routeResult,
    evening: routeResult,
    debug: debugInfo
  };
}

async function geocodeAddress(address, apiKey, debugInfo, label) {
  const params = new URLSearchParams({
    text: address,
    apiKey: apiKey,
    limit: 1,
    filter: 'countrycode:us', // Focus on US addresses for StreetEasy
    bias: 'proximity:-73.968285,40.785091' // Bias towards NYC center
  });

  const url = `https://api.geoapify.com/v1/geocode/search?${params}`;

  if (debugInfo) {
    debugInfo.steps.push({ step: `Geocoding ${label}`, url: url.replace(apiKey, 'REDACTED') });
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Network error during geocoding.');
  }

  const data = await response.json();

  if (data.features && data.features.length > 0) {
    const coords = data.features[0].geometry.coordinates;
    const result = {
      lat: coords[1],
      lon: coords[0]
    };
    if (debugInfo) {
      debugInfo.steps.push({ step: `Geocoding ${label} Success`, result, raw: data.features[0].properties });
    }
    return result;
  }

  if (debugInfo) {
    debugInfo.steps.push({ step: `Geocoding ${label} Failed`, address });
  }
  return null;
}

async function fetchTransitRoute(from, to, apiKey, debugInfo) {
  // Geoapify routing API uses waypoints as lat,lon|lat,lon
  const waypoints = `${from.lat},${from.lon}|${to.lat},${to.lon}`;

  const params = new URLSearchParams({
    waypoints: waypoints,
    mode: 'transit',
    apiKey: apiKey
  });

  const url = `https://api.geoapify.com/v1/routing?${params}`;
  if (debugInfo) {
    debugInfo.steps.push({ step: 'Routing API Request', url: url.replace(apiKey, 'REDACTED') });
  }

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Invalid API key. Please check your key in the Pace popup.');
    }
    throw new Error('Network error. Please check your connection.');
  }

  const data = await response.json();

  if (data.error) {
    if (debugInfo) debugInfo.steps.push({ step: 'Routing API Error', error: data.error });
    throw new Error(data.error.message || 'Routing API error');
  }

  if (!data.features || data.features.length === 0) {
    if (debugInfo) debugInfo.steps.push({ step: 'Routing API No Results', data });
    return { text: 'No transit route', minutes: null };
  }

  const route = data.features[0];
  const properties = route.properties;

  if (!properties || !properties.time) {
    if (debugInfo) debugInfo.steps.push({ step: 'Routing API No Time Property', properties });
    return { text: 'No transit route', minutes: null };
  }

  // Convert seconds to minutes
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
