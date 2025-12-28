// Pace - StreetEasy Commute Times Content Script

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Simple LRU cache with TTL support.
 * - Evicts oldest entries when maxSize is exceeded
 * - Entries expire after ttlMs milliseconds
 * - Uses Map's insertion order for LRU tracking
 */
class LRUCache {
  constructor(maxSize = 100, ttlMs = 30 * 60 * 1000) { // Default: 100 entries, 30 min TTL
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // key -> { value, timestamp }
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    const entry = this.cache.get(key);
    // Check if expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  get(key) {
    if (!this.has(key)) return undefined;
    const entry = this.cache.get(key);
    // Move to end (most recently used) by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    // Delete first if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

let currentUrl = window.location.href;
let isProcessing = false;
let debugMode = false; // Module-level debug flag, loaded from storage

// Search results state
const commuteCache = new LRUCache(100, 30 * 60 * 1000); // 100 entries max, 30 min TTL
const processedCards = new WeakSet(); // track processed card elements
let searchResultsObserver = null;
let intersectionObserver = null;
let searchResultsDebounceTimer = null; // debounce timer for mutation observer
const pendingRequests = new Map(); // address -> Promise (for deduplication)
const MAX_CONCURRENT_REQUESTS = 3;
let activeRequests = 0;
const requestQueue = [];

// Initialize on page load
init();

async function init() {
  // Load debug mode setting
  const settings = await chrome.storage.sync.get(['debugMode']);
  debugMode = settings.debugMode || false;

  if (isListingPage()) {
    processListing();
  } else if (isSearchResultsPage()) {
    setTimeout(processSearchResults, 500);
  }

  // Watch for SPA navigation using MutationObserver
  const observer = new MutationObserver(() => {
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      // Remove existing widget when navigating away
      removeWidget();
      cleanupSearchResultsObservers();

      if (isListingPage()) {
        // Small delay to let page content load
        setTimeout(processListing, 500);
      } else if (isSearchResultsPage()) {
        setTimeout(processSearchResults, 500);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Handle back/forward navigation
  window.addEventListener('popstate', () => {
    removeWidget();
    cleanupSearchResultsObservers();

    if (isListingPage()) {
      setTimeout(processListing, 500);
    } else if (isSearchResultsPage()) {
      setTimeout(processSearchResults, 500);
    }
  });

  // Clear cache when work address changes (user updated settings)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && (changes.workAddress || changes.workCoords)) {
      if (debugMode) {
        console.log('[Pace] Work address changed, clearing commute cache');
      }
      commuteCache.clear();
    }
  });
}

function isListingPage() {
  const path = window.location.pathname;
  // Match individual listing pages
  // /building/[name], /rental/[id], /sale/[id], /for-rent/[address]
  return (
    path.includes('/building/') ||
    path.includes('/rental/') ||
    path.includes('/sale/') ||
    /\/for-rent\/\d+/.test(path) ||
    /\/for-sale\/\d+/.test(path)
  );
}

function isSearchResultsPage() {
  const path = window.location.pathname;
  // Match search results pages: /for-rent/nyc/..., /for-sale/nyc/...
  // But NOT individual listings which have numeric IDs: /for-rent/12345
  const isForRentSearch = path.startsWith('/for-rent/') && !/\/for-rent\/\d+$/.test(path);
  const isForSaleSearch = path.startsWith('/for-sale/') && !/\/for-sale\/\d+$/.test(path);
  return isForRentSearch || isForSaleSearch;
}

async function processListing() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Wait for page content to load
    await waitForContent();

    // Load settings
    const { workAddress } = await chrome.storage.sync.get(['workAddress']);

    if (debugMode) {
      console.group('[Pace Debug] Listing Processing');
      console.log('URL:', window.location.href);
    }

    const address = extractAddress();
    if (!address) {
      if (debugMode) {
        console.error('Failed to extract address from page');
        console.groupEnd();
      }
      injectWidget({ error: 'Could not detect address on this page.' });
      return;
    }

    if (debugMode) {
      console.log('Extracted Address:', address);
      console.log('Work Address:', workAddress);
    }

    // Show loading state
    injectWidget({ loading: true, apartmentAddress: address, workAddress });

    // Request commute times from service worker
    const response = await chrome.runtime.sendMessage({
      type: 'GET_COMMUTE_TIMES',
      apartmentAddress: address
    });

    if (debugMode) {
      console.log('Service Worker Response:', response);
      if (response.debug) {
        console.group('API Steps');
        response.debug.steps.forEach(s => console.log(`[${s.step}]`, s));
        console.groupEnd();
      }
      console.groupEnd();
    }

    if (response.error) {
      injectWidget({ error: response.error, apartmentAddress: address, workAddress });
    } else {
      injectWidget({
        morning: response.morning,
        evening: response.evening,
        apartmentAddress: address,
        workAddress,
        apartmentFormatted: response.apartmentFormatted,
        workFormatted: response.workFormatted
      });
    }
  } catch (error) {
    if (debugMode) {
      console.error('[Pace] Error:', error);
    }
    injectWidget({ error: 'Failed to calculate commute times.' });
  } finally {
    isProcessing = false;
  }
}

async function waitForContent() {
  // Wait up to 5 seconds for page content
  const maxWait = 5000;
  const interval = 100;
  let waited = 0;

  while (waited < maxWait) {
    // Check if main content has loaded
    if (document.querySelector('h1') || document.querySelector('[class*="address"]')) {
      // Content found - now wait for DOM to stabilize before injecting
      await waitForDomToSettle();
      return;
    }
    await sleep(interval);
    waited += interval;
  }
}

async function waitForDomToSettle(stabilityThreshold = 300, maxWait = 2000) {
  // Wait until no DOM mutations occur for stabilityThreshold ms
  // This ensures StreetEasy's SPA has finished rendering
  return new Promise((resolve) => {
    let timeoutId;
    let totalWaited = 0;
    const checkInterval = 50;

    const observer = new MutationObserver(() => {
      // Reset the stability timer on each mutation
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, stabilityThreshold);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Start the initial stability timer
    timeoutId = setTimeout(() => {
      observer.disconnect();
      resolve();
    }, stabilityThreshold);

    // Safety timeout - don't wait forever
    const safetyInterval = setInterval(() => {
      totalWaited += checkInterval;
      if (totalWaited >= maxWait) {
        clearInterval(safetyInterval);
        clearTimeout(timeoutId);
        observer.disconnect();
        resolve();
      }
    }, checkInterval);
  });
}

/**
 * Extracts the apartment address from a StreetEasy listing page.
 * Tries multiple strategies: DOM elements and JSON-LD structured data.
 * @returns {string|null} The extracted address or null if not found/invalid
 */
function extractAddress() {
  // Primary: "About the building" section contains the full formatted address
  const addressEl = document.querySelector('[class*="AboutBuildingSection_address"]');
  if (addressEl) {
    const address = addressEl.textContent.trim();
    if (debugMode) {
      console.log('[Pace] Address from AboutBuildingSection:', address);
    }
    // Validate before returning
    if (isValidExtractedAddress(address)) {
      return address;
    }
    if (debugMode) {
      console.log('[Pace] Address failed validation:', address);
    }
  }

  // Fallback: Try JSON-LD structured data
  const jsonLdAddress = extractFromJsonLd();
  if (jsonLdAddress) {
    if (debugMode) {
      console.log('[Pace] Address from JSON-LD:', jsonLdAddress);
    }
    // Validate before returning
    if (isValidExtractedAddress(jsonLdAddress)) {
      return jsonLdAddress;
    }
    if (debugMode) {
      console.log('[Pace] JSON-LD address failed validation:', jsonLdAddress);
    }
  }

  if (debugMode) {
    console.log('[Pace] Could not extract valid address');
  }
  return null;
}

function extractFromJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);

      // Handle array of schemas
      const schemas = Array.isArray(data) ? data : [data];

      for (const schema of schemas) {
        // Check for address in various schema types
        if (schema.address) {
          if (typeof schema.address === 'string') {
            return schema.address;
          }
          if (schema.address.streetAddress) {
            const parts = [
              schema.address.streetAddress,
              schema.address.addressLocality,
              schema.address.addressRegion
            ].filter(Boolean);
            return parts.join(', ');
          }
        }

        // Check for location
        if (schema.location?.address) {
          return typeof schema.location.address === 'string'
            ? schema.location.address
            : schema.location.address.streetAddress;
        }
      }
    } catch (e) {
      // Invalid JSON, continue
    }
  }
  return null;
}

function isAddressLike(text) {
  if (!text || text.length < 5) return false;

  // Check for NYC-like patterns
  const addressPatterns = [
    /\d+\s+\w+/,                           // Number followed by word (street)
    /\b(street|st|avenue|ave|road|rd|boulevard|blvd|place|pl|way|drive|dr)\b/i,
    /\b(new york|nyc|brooklyn|manhattan|queens|bronx|staten island)\b/i,
    /\b(ny|nyc)\b/i,
    /\b\d{5}\b/                            // ZIP code
  ];

  return addressPatterns.some(pattern => pattern.test(text));
}

/**
 * Validates that an extracted address is usable for geocoding.
 * Filters out common invalid patterns that would waste API calls.
 */
function isValidExtractedAddress(text) {
  if (!text || typeof text !== 'string') return false;

  const trimmed = text.trim();

  // Too short to be a valid address
  if (trimmed.length < 5) return false;

  // Too long - probably grabbed wrong element
  if (trimmed.length > 200) return false;

  // Common placeholder/loading patterns (case-insensitive)
  const invalidPatterns = [
    /^loading/i,
    /^error/i,
    /^n\/?a$/i,
    /^tbd$/i,
    /^pending/i,
    /^unavailable/i,
    /^unknown/i,
    /^null$/i,
    /^undefined$/i,
    /^\.\.\./,
    /^-+$/,
    /^_+$/
  ];

  if (invalidPatterns.some(pattern => pattern.test(trimmed))) {
    return false;
  }

  // Must have at least one letter (not just numbers/symbols)
  if (!/[a-zA-Z]/.test(trimmed)) {
    return false;
  }

  // Should look like an address (has a number followed by text, or contains street-like words)
  return isAddressLike(trimmed);
}

function cleanAddress(text) {
  // Remove common suffixes and clean up
  return text
    .split('|')[0]                          // Remove "| StreetEasy" suffix
    .split(' - ')[0]                        // Remove " - For Rent" suffix
    .split(' for ')[0]                      // Remove "for rent/sale"
    .replace(/\s*#\S+/g, '')                // Remove apartment numbers (e.g., #574, #UNIT2)
    .replace(/\s+/g, ' ')                   // Normalize whitespace
    .trim();
}

function removeWidget() {
  const existing = document.getElementById('pace-commute-widget');
  if (existing) {
    existing.remove();
  }
}

function injectWidget({ loading, error, morning, evening, apartmentAddress, workAddress, apartmentFormatted, workFormatted }) {
  removeWidget();



  const hasRoute = Boolean(apartmentAddress && workAddress);
  const routeHtml = hasRoute
    ? `
      <div class="pace-route" title="${escapeHtml(`${apartmentAddress} → ${workAddress}`)}">
        <span class="pace-route-part">${escapeHtml(formatShortAddress(apartmentAddress))}</span>
        <span class="pace-route-to">to</span>
        <span class="pace-route-part">${escapeHtml(formatShortAddress(workAddress))}</span>
      </div>
    `
    : '';

  const actionHtml = hasRoute && !loading && !error
    ? `
      <div class="pace-actions">
        <button type="button" class="pace-btn" data-pace-action="open-route">VIEW ROUTE ON GOOGLE MAPS</button>
      </div>
    `
    : '';

  // small separator to replace the removed header (keeps the underline)
  const separatorHtml = `<div class="pace-separator"></div>`;

  const widget = document.createElement('div');
  widget.id = 'pace-commute-widget';

  if (hasRoute) {
    widget.dataset.paceFrom = apartmentAddress;
    widget.dataset.paceTo = workAddress;
    if (apartmentFormatted) {
      widget.dataset.paceFromFormatted = apartmentFormatted;
    }
    if (workFormatted) {
      widget.dataset.paceToFormatted = workFormatted;
    }
  }

  if (loading) {
    widget.innerHTML = `
      ${separatorHtml}
      ${routeHtml}
      <div class="pace-loading">
        <div class="pace-spinner"></div>
        <span>Calculating commute times...</span>
      </div>
    `;
  } else if (error) {
    widget.innerHTML = `
      ${separatorHtml}
      ${routeHtml}
      <div class="pace-error">
        <span class="pace-error-icon">&#9888;</span>
        <span>${escapeHtml(error)}</span>
      </div>
    `;
  } else {
    widget.innerHTML = `
      ${separatorHtml}
      ${routeHtml}
      <div class="pace-times">
        <div class="pace-row pace-main">
          <span class="pace-value pace-large">${escapeHtml(morning?.text || 'N/A')}</span>
        </div>
      </div>
      <div class="pace-note">Average public transit time (provided by Geoapify)</div>
      ${actionHtml}
    `;
  }

  // Button-only action: open Google Maps directions.
  const actionButton = widget.querySelector('[data-pace-action="open-route"]');
  if (actionButton) {
    actionButton.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }

        const from = widget.dataset.paceFrom;
        const to = widget.dataset.paceToFormatted;
        if (!from || !to) return;

        const url = buildGoogleMapsDirectionsUrl(from, to);
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      true
    );
  }

  // Find best insertion point
  const insertionPoint = findInsertionPoint();
  if (insertionPoint.element) {
    insertWidgetSafely(widget, insertionPoint);
  } else {
    // Fallback: insert at top of body
    document.body.prepend(widget);
  }
}

function insertWidgetSafely(widget, insertionPoint) {
  const element = insertionPoint.element;
  if (!element) return;

  // If our chosen insertion element is inside a link, insert next to the link
  // to avoid making the whole widget navigate to StreetEasy.
  const linkAncestor = element.closest('a');
  const insertionElement = linkAncestor || element;

  if (insertionPoint.position === 'after') {
    insertionElement.parentNode.insertBefore(widget, insertionElement.nextSibling);
  } else if (insertionPoint.position === 'before') {
    insertionElement.parentNode.insertBefore(widget, insertionElement);
  } else {
    if (linkAncestor) {
      // Never prepend inside a link.
      insertionElement.parentNode.insertBefore(widget, insertionElement.nextSibling);
    } else {
      insertionElement.prepend(widget);
    }
  }
}

function buildGoogleMapsDirectionsUrl(fromAddress, toAddress) {
  // Use Google Maps legacy URL format with departure time for next Monday at 8 AM
  // We use + for spaces as it's more standard for Google Maps path segments
  const from = encodeURIComponent(fromAddress).replace(/%20/g, '+');
  const to = encodeURIComponent(toAddress).replace(/%20/g, '+');

  // Calculate next Monday at 8 AM local time
  const nextMondayTimestamp = getNextMondayAt8AM();

  // Build URL with correct nested container structure:
  // !4m6!4m5 - nested containers
  // !2m3!6e0!7e2!8j{timestamp} - time settings (6e0=depart at, 7e2=use local time for timestamp, 8j=timestamp)
  // !3e3 - transit mode
  // dirflg=r - legacy flag to ensure transit mode is selected (especially on mobile)
  // Reference: https://mstickles.wordpress.com/2015/06/23/gmaps-urls-diropt3/
  return `https://www.google.com/maps/dir/${from}/${to}/data=!4m6!4m5!2m3!6e0!7e2!8j${nextMondayTimestamp}!3e3?dirflg=r`;
}

function getNextMondayAt8AM() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ...

  // Calculate days until next Monday
  // If today is Monday and before 8 AM, use today; otherwise next Monday
  let daysUntilMonday;
  if (dayOfWeek === 1) {
    // Today is Monday - check if it's before 8 AM
    const currentHour = now.getHours();
    if (currentHour < 8) {
      daysUntilMonday = 0; // Use today
    } else {
      daysUntilMonday = 7; // Use next Monday
    }
  } else if (dayOfWeek === 0) {
    // Sunday - next Monday is tomorrow
    daysUntilMonday = 1;
  } else {
    // Tuesday-Saturday: calculate days to next Monday
    daysUntilMonday = (8 - dayOfWeek) % 7;
  }

  // Create date for next Monday at 8:00 AM local time
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  nextMonday.setHours(8, 0, 0, 0);

  // Google Maps with !7e2 interprets the timestamp as a local time value,
  // not as UTC. So we subtract the timezone offset to make the timestamp
  // "look like" 8 AM when Google Maps reads it without conversion.
  const offsetSeconds = nextMonday.getTimezoneOffset() * 60;
  return Math.floor(nextMonday.getTime() / 1000) - offsetSeconds;
}

function formatShortAddress(address) {
  if (!address) return '';
  // Remove trailing ZIP and redundant "NY" if present; keep it simple.
  return address
    .replace(/,\s*NY\s*\d{5}(?:-\d{4})?\b/i, ', NY')
    .replace(/\b\d{5}(?:-\d{4})?\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

function findInsertionPoint() {
  // Try to find address-related elements to insert near
  const addressSelectors = [
    'h1',
    '[class*="address"]',
    '[class*="Address"]',
    '[class*="title"]',
    '.details-header',
    '.listing-details'
  ];

  for (const selector of addressSelectors) {
    const element = document.querySelector(selector);
    if (element && element.offsetParent !== null) {
      return { element, position: 'after' };
    }
  }

  // Try main content area
  const mainContent = document.querySelector('main') || document.querySelector('[role="main"]');
  if (mainContent) {
    return { element: mainContent, position: 'prepend' };
  }

  return { element: null };
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==================== SEARCH RESULTS FUNCTIONALITY ====================

function cleanupSearchResultsObservers() {
  if (searchResultsDebounceTimer) {
    clearTimeout(searchResultsDebounceTimer);
    searchResultsDebounceTimer = null;
  }
  if (searchResultsObserver) {
    searchResultsObserver.disconnect();
    searchResultsObserver = null;
  }
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
  // Clear request queue
  requestQueue.length = 0;
  activeRequests = 0;
}

async function processSearchResults() {
  // Check if user has configured the extension
  const { workAddress, apiKey } = await chrome.storage.sync.get(['workAddress', 'apiKey']);
  if (!workAddress || !apiKey) {
    if (debugMode) {
      console.log('[Pace] Extension not configured - skipping search results processing');
    }
    return;
  }

  // Wait for page content to stabilize
  await waitForDomToSettle(300, 3000);

  // Find all listing cards
  const cards = findListingCards();
  if (debugMode) {
    console.log(`[Pace] Found ${cards.length} listing cards on search results page`);
  }

  if (cards.length === 0) return;

  // Set up Intersection Observer for lazy loading
  setupIntersectionObserver();

  // Observe all cards
  cards.forEach(card => {
    if (!processedCards.has(card)) {
      intersectionObserver.observe(card);
    }
  });

  // Set up MutationObserver for infinite scroll / filter changes
  setupSearchResultsObserver();
}

function findListingCards() {
  // Primary selector: StreetEasy uses data-testid="listing-card"
  const cards = document.querySelectorAll('[data-testid="listing-card"]');
  if (cards.length > 0) {
    if (debugMode) {
      console.log(`[Pace] Found ${cards.length} cards using data-testid="listing-card"`);
    }
    return Array.from(cards);
  }

  // Fallback selectors
  const fallbackSelectors = [
    '[class*="ListingCard-module__cardContainer"]',
    '[class*="ListingCard"]',
    '[class*="listingCard"]'
  ];

  for (const selector of fallbackSelectors) {
    const fallbackCards = document.querySelectorAll(selector);
    if (fallbackCards.length > 0) {
      if (debugMode) {
        console.log(`[Pace] Found ${fallbackCards.length} cards using selector: ${selector}`);
      }
      return Array.from(fallbackCards);
    }
  }

  if (debugMode) {
    console.log('[Pace] No listing cards found');
  }
  return [];
}

// NJ main cities (these get used directly as "{city}, NJ")
const NJ_CITIES = new Set([
  'bayonne', 'cliffside park', 'east newark', 'edgewater', 'fort lee',
  'guttenberg', 'harrison', 'hoboken', 'jersey city', 'kearny',
  'north bergen', 'secaucus', 'union city', 'weehawken', 'west new york'
]);

// Jersey City sub-neighborhoods (these get mapped to "Jersey City, NJ")
const JERSEY_CITY_NEIGHBORHOODS = new Set([
  'bergen/lafayette', 'historic downtown', 'journal square', 'mcginley square',
  'newport', 'the heights', 'waterfront', 'paulus hook', 'west side'
]);

/**
 * Extracts the apartment address from a StreetEasy search result card.
 * Combines street address with city/state based on neighborhood.
 * @param {Element} card - The listing card DOM element
 * @returns {string|null} Full address (e.g., "123 Main St, New York, NY") or null if not found
 */
function extractAddressFromCard(card) {
  // StreetEasy address link has class containing "ListingDescription-module__addressTextAction"
  // e.g., <a class="... ListingDescription-module__addressTextAction___xAFZJ">150 East 44th Street #48F</a>

  let streetAddress = null;

  // Strategy 1: Look for the specific address link class
  const addressLink = card.querySelector('a[class*="ListingDescription-module__addressTextAction"]');
  if (addressLink) {
    const text = addressLink.textContent.trim();
    if (text && text.length > 0) {
      streetAddress = text;
    }
  }

  // Strategy 2: Look for address-related classes
  if (!streetAddress) {
    const addressSelectors = [
      '[class*="addressTextAction"]',
      '[class*="address"]',
      '[class*="Address"]'
    ];

    for (const selector of addressSelectors) {
      const element = card.querySelector(selector);
      if (element?.textContent?.trim()) {
        const text = element.textContent.trim();
        if (isAddressLike(text) && text.length < 100) {
          streetAddress = cleanAddress(text);
          break;
        }
      }
    }
  }

  // Strategy 3: Look for any link that looks like an address
  if (!streetAddress) {
    const links = card.querySelectorAll('a');
    for (const link of links) {
      const text = link.textContent.trim();
      if (isAddressLike(text) && text.length < 100) {
        streetAddress = text;
        break;
      }
    }
  }

  if (!streetAddress) return null;

  // Clean the street address to remove apartment numbers, etc.
  streetAddress = cleanAddress(streetAddress);

  // Validate the cleaned address before making API calls
  if (!isValidExtractedAddress(streetAddress)) {
    if (debugMode) {
      console.log('[Pace] Card address failed validation:', streetAddress);
    }
    return null;
  }

  // Extract neighborhood from the card's title (e.g., "RENTAL UNIT IN LINCOLN SQUARE")
  const neighborhood = extractNeighborhoodFromCard(card);

  // Build full address with city/state for geocoding
  // Don't include neighborhood names to avoid matching to wrong locations
  // (e.g., "Beekman" is both a Manhattan neighborhood and an upstate NY town)
  if (neighborhood) {
    const neighborhoodLower = neighborhood.toLowerCase();

    // NJ main city - use city name directly
    if (NJ_CITIES.has(neighborhoodLower)) {
      return `${streetAddress}, ${neighborhood}, NJ`;
    }

    // Jersey City sub-neighborhood - map to Jersey City
    if (JERSEY_CITY_NEIGHBORHOODS.has(neighborhoodLower)) {
      return `${streetAddress}, Jersey City, NJ`;
    }

    // All NYC neighborhoods (Manhattan, Brooklyn, Queens, Bronx, Staten Island)
    // Just use "New York, NY" - street addresses are specific enough
    return `${streetAddress}, New York, NY`;
  }

  // Fallback: assume NYC
  return `${streetAddress}, New York, NY`;
}

function extractNeighborhoodFromCard(card) {
  // Look for the title element like "RENTAL UNIT IN YORKVILLE" or "CONDO IN MIDTOWN"
  const titleElement = card.querySelector('[class*="ListingDescription-module__title"]');
  if (titleElement) {
    const text = titleElement.textContent.trim();
    // Extract neighborhood after "in " (case insensitive)
    const match = text.match(/\bin\s+(.+)$/i);
    if (match) {
      return match[1].trim();
    }
  }

  // Fallback: look for any element with "in [Neighborhood]" pattern
  const allText = card.textContent;
  const patterns = [
    /rental unit in\s+([^$\d]+?)(?=\s*\$|\s*\d|$)/i,
    /condo(?:minium)? in\s+([^$\d]+?)(?=\s*\$|\s*\d|$)/i,
    /co-?op in\s+([^$\d]+?)(?=\s*\$|\s*\d|$)/i,
    /(?:single|two|multi)-?family (?:home )?in\s+([^$\d]+?)(?=\s*\$|\s*\d|$)/i,
    /townhouse in\s+([^$\d]+?)(?=\s*\$|\s*\d|$)/i
  ];

  for (const pattern of patterns) {
    const match = allText.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

function findBedsBathsList(card) {
  // Find the <ul> that contains beds/baths/sqft items
  // StreetEasy uses: ul.BedsBathsSqft-module__list___*

  // Strategy 1: Look for the specific BedsBathsSqft list class
  const bedsBathsList = card.querySelector('ul[class*="BedsBathsSqft-module__list"]');
  if (bedsBathsList) {
    return bedsBathsList;
  }

  // Strategy 2: Look for ul that contains li items with bed/bath text
  const lists = card.querySelectorAll('ul');
  for (const ul of lists) {
    const text = ul.textContent.toLowerCase();
    if ((text.includes('bed') || text.includes('bath') || text.includes('studio')) &&
        text.includes('ft')) {
      return ul;
    }
  }

  // Strategy 3: Fallback - find any container with bed/bath items
  const containers = card.querySelectorAll('[class*="BedsBaths"], [class*="bedsBaths"]');
  for (const container of containers) {
    const ul = container.querySelector('ul');
    if (ul) return ul;
  }

  return null;
}

function injectCommuteBadge(card, { loading, error, time, address }) {
  // Remove existing badge if any
  const existingBadge = card.querySelector('.pace-search-badge');
  if (existingBadge) {
    existingBadge.remove();
  }

  // Find the beds/baths/sqft list
  const bedsBathsList = findBedsBathsList(card);

  if (bedsBathsList) {
    // Create an <li> element to match the existing list structure
    const badgeLi = document.createElement('li');
    badgeLi.className = 'pace-search-badge';
    badgeLi.dataset.paceAddress = address || '';

    // Try to copy the class from existing list items for consistent styling
    const existingItem = bedsBathsList.querySelector('li');
    if (existingItem && existingItem.className) {
      badgeLi.className = existingItem.className + ' pace-search-badge';
    }

    // SVG transit icon matching StreetEasy's icon style
    const transitIcon = `<svg height="16" viewBox="0 0 24 24" width="16" xmlns="http://www.w3.org/2000/svg" class="pace-badge-icon" fill="#949494"><path d="M12 2C8 2 4 2.5 4 6v9.5c0 1.93 1.57 3.5 3.5 3.5L6 20.5v.5h2l1.5-1.5h5L16 21h2v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm3.5-6H6V6h5v5zm2 0V6h5v5h-5zm3.5 6c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`;

    if (loading) {
      badgeLi.innerHTML = `${transitIcon}<span class="pace-badge-text">...</span>`;
      badgeLi.classList.add('pace-badge-loading');
    } else if (error) {
      badgeLi.innerHTML = `${transitIcon}<span class="pace-badge-text">--</span>`;
      badgeLi.classList.add('pace-badge-error');
      badgeLi.title = error;
    } else {
      badgeLi.innerHTML = `${transitIcon}<span class="pace-badge-text">${escapeHtml(time)}</span>`;
      badgeLi.classList.add('pace-badge-success');
    }

    // Append to the list
    bedsBathsList.appendChild(badgeLi);
  } else {
    // Fallback: create a span badge and append to card
    const badge = document.createElement('span');
    badge.className = 'pace-search-badge';
    badge.dataset.paceAddress = address || '';

    const transitIcon = `<svg height="16" viewBox="0 0 24 24" width="16" xmlns="http://www.w3.org/2000/svg" class="pace-badge-icon" fill="#949494"><path d="M12 2C8 2 4 2.5 4 6v9.5c0 1.93 1.57 3.5 3.5 3.5L6 20.5v.5h2l1.5-1.5h5L16 21h2v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm3.5-6H6V6h5v5zm2 0V6h5v5h-5zm3.5 6c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`;

    if (loading) {
      badge.innerHTML = `${transitIcon}<span class="pace-badge-text">...</span>`;
      badge.classList.add('pace-badge-loading');
    } else if (error) {
      badge.innerHTML = `${transitIcon}<span class="pace-badge-text">--</span>`;
      badge.classList.add('pace-badge-error');
      badge.title = error;
    } else {
      badge.innerHTML = `${transitIcon}<span class="pace-badge-text">${escapeHtml(time)}</span>`;
      badge.classList.add('pace-badge-success');
    }

    card.appendChild(badge);
  }
}

function setupIntersectionObserver() {
  if (intersectionObserver) return;

  intersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const card = entry.target;
          if (!processedCards.has(card)) {
            processedCards.add(card);
            queueCardForProcessing(card);
          }
          // Stop observing this card
          intersectionObserver.unobserve(card);
        }
      });
    },
    {
      rootMargin: '100px', // Start loading slightly before card is visible
      threshold: 0
    }
  );
}

function setupSearchResultsObserver() {
  if (searchResultsObserver) return;

  searchResultsObserver = new MutationObserver((mutations) => {
    // Check if any element nodes were added (quick check before debouncing)
    const hasElementNodes = mutations.some(mutation =>
      Array.from(mutation.addedNodes).some(node => node.nodeType === Node.ELEMENT_NODE)
    );

    if (!hasElementNodes) return;

    // Debounce: wait for DOM to settle before querying for new cards
    // This prevents calling findListingCards() hundreds of times during infinite scroll
    clearTimeout(searchResultsDebounceTimer);
    searchResultsDebounceTimer = setTimeout(() => {
      const newCards = findListingCards();
      let observedCount = 0;

      newCards.forEach(card => {
        if (!processedCards.has(card) && intersectionObserver) {
          intersectionObserver.observe(card);
          observedCount++;
        }
      });

      if (observedCount > 0 && debugMode) {
        console.log(`[Pace] New listing cards detected: ${observedCount}`);
      }
    }, 200); // 200ms debounce - balances responsiveness with efficiency
  });

  // Observe the main content area for changes
  const contentArea = document.querySelector('main') || document.body;
  searchResultsObserver.observe(contentArea, {
    childList: true,
    subtree: true
  });
}

/**
 * Queues a listing card for commute time processing.
 * Checks cache first, then adds to request queue if needed.
 * @param {Element} card - The listing card DOM element
 */
function queueCardForProcessing(card) {
  const address = extractAddressFromCard(card);

  if (!address) {
    if (debugMode) {
      console.log('[Pace] Could not extract address from card');
    }
    return;
  }

  // Show loading state
  injectCommuteBadge(card, { loading: true, address });

  // Check cache first
  if (commuteCache.has(address)) {
    const cached = commuteCache.get(address);
    injectCommuteBadge(card, cached);
    return;
  }

  // Add to queue
  requestQueue.push({ card, address });
  processQueue();
}

async function processQueue() {
  while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
    const item = requestQueue.shift();
    if (!item) break;

    activeRequests++;
    processCardRequest(item).finally(() => {
      activeRequests--;
      processQueue(); // Continue processing queue
    });
  }
}

async function processCardRequest({ card, address }) {
  try {
    // Check if there's already a pending request for this address
    if (pendingRequests.has(address)) {
      const result = await pendingRequests.get(address);
      injectCommuteBadge(card, result);
      return;
    }

    // Create the request promise
    const requestPromise = getCommuteTimeForAddress(address);
    pendingRequests.set(address, requestPromise);

    const result = await requestPromise;

    // Cache the result
    commuteCache.set(address, result);
    pendingRequests.delete(address);

    // Update the badge
    injectCommuteBadge(card, result);
  } catch (error) {
    if (debugMode) {
      console.error('[Pace] Error processing card:', error);
    }
    const result = { error: 'Failed to get commute time', address };
    commuteCache.set(address, result);
    pendingRequests.delete(address);
    injectCommuteBadge(card, result);
  }
}

/**
 * Fetches commute time for an address from the service worker.
 * Includes retry logic for transient errors.
 * @param {string} address - The apartment address to get commute time for
 * @param {number} [maxRetries=2] - Maximum number of retry attempts
 * @returns {Promise<{time: string, address: string}|{error: string, address: string}>} Result or error
 */
async function getCommuteTimeForAddress(address, maxRetries = 2) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Add delay before retry (not on first attempt)
      if (attempt > 0) {
        if (debugMode) {
          console.log(`[Pace] Retrying request for ${address} (attempt ${attempt + 1}/${maxRetries + 1})`);
        }
        await sleep(500 * attempt); // 500ms, 1000ms for retries
      }

      const response = await chrome.runtime.sendMessage({
        type: 'GET_COMMUTE_TIMES',
        apartmentAddress: address
      });

      // Check if we got a valid response
      if (!response) {
        if (debugMode) {
          console.warn(`[Pace] No response from service worker for ${address}`);
        }
        lastError = 'No response from service worker';
        continue;
      }

      if (response.error) {
        if (debugMode) {
          console.warn(`[Pace] Error for ${address}:`, response.error);
        }
        lastError = response.error;
        // Don't retry for permanent errors (these won't succeed on retry)
        const permanentErrors = [
          'not found', 'invalid', 'No transit route', 'wrong location',
          'not in NYC', 'No path', 'Please set'
        ];
        if (permanentErrors.some(e => response.error.includes(e))) {
          return { error: response.error, address };
        }
        continue; // Retry for transient errors (network issues, etc.)
      }

      return {
        time: response.morning?.text || 'N/A',
        address
      };
    } catch (error) {
      if (debugMode) {
        console.error(`[Pace] API error (attempt ${attempt + 1}):`, error);
      }
      lastError = 'API error';
    }
  }

  // All retries exhausted
  if (debugMode) {
    console.log(`[Pace] All retries exhausted for ${address}`);
  }
  return { error: lastError || 'Failed after retries', address };
}
