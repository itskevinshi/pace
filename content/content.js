// Pace - StreetEasy Commute Times Content Script

let currentUrl = window.location.href;
let isProcessing = false;

// Initialize on page load
init();

function init() {
  if (isListingPage()) {
    processListing();
  }

  // Watch for SPA navigation using MutationObserver
  const observer = new MutationObserver(() => {
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      // Remove existing widget when navigating away
      removeWidget();
      if (isListingPage()) {
        // Small delay to let page content load
        setTimeout(processListing, 500);
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
    if (isListingPage()) {
      setTimeout(processListing, 500);
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

async function processListing() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Wait for page content to load
    await waitForContent();

    const address = extractAddress();
    if (!address) {
      console.log('[Pace] Could not extract address from this page');
      injectWidget({ error: 'Could not detect address on this page.' });
      return;
    }

    // Load work address for display + Google Maps deep link.
    let workAddress;
    try {
      ({ workAddress } = await chrome.storage.sync.get(['workAddress']));
    } catch (e) {
      // Non-fatal; service worker will still validate.
    }

    console.log('[Pace] Extracted address:', address);

    // Show loading state
    injectWidget({ loading: true, apartmentAddress: address, workAddress });

    // Request commute times from service worker
    const response = await chrome.runtime.sendMessage({
      type: 'GET_COMMUTE_TIMES',
      apartmentAddress: address
    });

    if (response.error) {
      injectWidget({ error: response.error, apartmentAddress: address, workAddress });
    } else {
      injectWidget({
        morning: response.morning,
        evening: response.evening,
        apartmentAddress: address,
        workAddress
      });
    }
  } catch (error) {
    console.error('[Pace] Error:', error);
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
      return;
    }
    await sleep(interval);
    waited += interval;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractAddress() {
  // Try multiple extraction strategies in order of reliability

  // 1. JSON-LD structured data (most reliable)
  const jsonLdAddress = extractFromJsonLd();
  if (jsonLdAddress) return jsonLdAddress;

  // 2. Meta tags
  const metaAddress = extractFromMeta();
  if (metaAddress) return metaAddress;

  // 3. Page title (often contains address)
  const titleAddress = extractFromTitle();
  if (titleAddress) return titleAddress;

  // 4. DOM elements with address-related classes
  const domAddress = extractFromDom();
  if (domAddress) return domAddress;

  // 5. URL parsing as last resort
  const urlAddress = extractFromUrl();
  if (urlAddress) return urlAddress;

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

function extractFromMeta() {
  // Try various meta tags that might contain address
  const selectors = [
    'meta[property="og:street-address"]',
    'meta[name="address"]',
    'meta[property="og:locality"]'
  ];

  for (const selector of selectors) {
    const meta = document.querySelector(selector);
    if (meta?.content) {
      return meta.content;
    }
  }

  // Try og:title which often includes address
  const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
  if (ogTitle && isAddressLike(ogTitle)) {
    return cleanAddress(ogTitle);
  }

  return null;
}

function extractFromTitle() {
  const title = document.title;
  // StreetEasy titles often have format: "Address | StreetEasy" or "Address - Apartment for Rent"
  if (title && isAddressLike(title)) {
    return cleanAddress(title);
  }
  return null;
}

function extractFromDom() {
  // Common selectors for address elements
  const selectors = [
    '[data-testid="listing-address"]',
    '[class*="ListingAddress"]',
    '[class*="listing-address"]',
    '[class*="PropertyAddress"]',
    '[itemprop="address"]',
    'h1[class*="address"]',
    '.listing-title h1',
    // StreetEasy specific patterns
    '[class*="Heading"] + [class*="Text"]',
    '.details-title',
    '.building-title'
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element?.textContent?.trim()) {
      const text = element.textContent.trim();
      if (isAddressLike(text)) {
        return cleanAddress(text);
      }
    }
  }

  // Try the first h1 as it often contains the address
  const h1 = document.querySelector('h1');
  if (h1?.textContent && isAddressLike(h1.textContent)) {
    return cleanAddress(h1.textContent);
  }

  return null;
}

function extractFromUrl() {
  const path = window.location.pathname;

  // /building/[building-name-address]
  const buildingMatch = path.match(/\/building\/([^\/]+)/);
  if (buildingMatch) {
    // Convert URL format to address
    const address = buildingMatch[1]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    return `${address}, New York, NY`;
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

function cleanAddress(text) {
  // Remove common suffixes and clean up
  return text
    .split('|')[0]                          // Remove "| StreetEasy" suffix
    .split(' - ')[0]                        // Remove " - For Rent" suffix
    .split(' for ')[0]                      // Remove "for rent/sale"
    .replace(/\s+/g, ' ')                   // Normalize whitespace
    .trim();
}

function removeWidget() {
  const existing = document.getElementById('pace-commute-widget');
  if (existing) {
    existing.remove();
  }
}

function injectWidget({ loading, error, morning, evening, apartmentAddress, workAddress }) {
  removeWidget();

  const hasRoute = Boolean(apartmentAddress && workAddress);
  const routeHtml = hasRoute
    ? `
      <div class="pace-route" title="${escapeHtml(`${apartmentAddress} → ${workAddress}`)}">
        <span class="pace-route-part">${escapeHtml(formatShortAddress(apartmentAddress))}</span>
        <span class="pace-route-arrow">&#8594;</span>
        <span class="pace-route-part">${escapeHtml(formatShortAddress(workAddress))}</span>
      </div>
    `
    : '';

  const widget = document.createElement('div');
  widget.id = 'pace-commute-widget';

  if (hasRoute) {
    widget.dataset.paceFrom = apartmentAddress;
    widget.dataset.paceTo = workAddress;
  }

  if (loading) {
    widget.innerHTML = `
      <div class="pace-header">
        <span class="pace-icon">&#128651;</span>
        <span class="pace-title">Commute to Work</span>
      </div>
      ${routeHtml}
      <div class="pace-loading">
        <div class="pace-spinner"></div>
        <span>Calculating commute times...</span>
      </div>
    `;
  } else if (error) {
    widget.innerHTML = `
      <div class="pace-header">
        <span class="pace-icon">&#128651;</span>
        <span class="pace-title">Commute to Work</span>
      </div>
      ${routeHtml}
      <div class="pace-error">
        <span class="pace-error-icon">&#9888;</span>
        <span>${escapeHtml(error)}</span>
      </div>
    `;
  } else {
    widget.innerHTML = `
      <div class="pace-header">
        <span class="pace-icon">&#128651;</span>
        <span class="pace-title">Commute to Work</span>
      </div>
      ${routeHtml}
      <div class="pace-times">
        <div class="pace-row pace-main">
          <span class="pace-label">Transit Time</span>
          <span class="pace-value pace-large">${escapeHtml(morning?.text || 'N/A')}</span>
        </div>
      </div>
      <div class="pace-note">Average public transit time</div>
    `;
  }

  // Clicking the card opens Google Maps directions instead of StreetEasy navigation.
  // Use capture to intercept clicks even if the widget was inserted within a link.
  widget.addEventListener(
    'click',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }

      const from = widget.dataset.paceFrom;
      const to = widget.dataset.paceTo;
      if (!from || !to) return;

      const url = buildGoogleMapsDirectionsUrl(from, to);
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    true
  );

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
  const from = encodeForGoogleMapsPath(fromAddress);
  const to = encodeForGoogleMapsPath(toAddress);
  return `https://www.google.com/maps/dir/${from}/${to}/`;
}

function encodeForGoogleMapsPath(address) {
  // Google Maps accepts both %20 and + for spaces in path segments.
  return encodeURIComponent(address).replace(/%20/g, '+');
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
