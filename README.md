# Pace

A Chrome extension that automatically displays public transit commute times on StreetEasy apartment listings.

## Features

- Automatically detects apartment addresses on StreetEasy listing pages
- Shows transit commute time to your work location
- Uses Geoapify's free API (no credit card required!)
- Works seamlessly - no clicking required

## Installation

### 1. Get a Free Geoapify API Key

1. Go to [Geoapify Registration](https://myprojects.geoapify.com/register)
2. Create a free account (no credit card needed)
3. Create a new project
4. Copy your API key

**Free tier includes 3,000 API calls per day** - more than enough for apartment hunting!

### 2. Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `pace` folder containing this extension

### 3. Configure the Extension

1. Click the Pace icon in your Chrome toolbar
2. Enter your work address (full address including city)
3. Enter your Geoapify API key
4. Click **Save Settings**

## Usage

Just browse StreetEasy! When you view any apartment listing, Pace will automatically:

1. Detect the apartment address
2. Calculate transit commute time
3. Display a widget on the page showing the commute duration

## How It Works

Pace uses [Geoapify's Routing API](https://www.geoapify.com/routing-api/) which provides:
- Public transit routing using official GTFS data
- Coverage for NYC and 40,000+ transit operators worldwide
- Average transit times (not time-specific, but accurate for planning)

Note: The commute time shown is an average - actual times may vary by a few minutes depending on time of day.

## Troubleshooting

**"Please set your work address"**
- Click the Pace icon and enter your work address

**"Invalid API key"**
- Make sure you copied the entire API key from Geoapify
- Check that your Geoapify account is active

**"No transit route found"**
- The API couldn't find a public transit route between these locations
- This may happen for very remote areas

**Widget doesn't appear**
- Make sure you're on an individual listing page (not search results)
- Try refreshing the page
- Check the browser console for errors

## Privacy

- Your work address and API key are stored locally in Chrome's sync storage
- Address lookups go directly to Geoapify's API
- No data is sent to any other third-party servers

## Development

```
pace/
├── manifest.json           # Extension configuration
├── popup/                  # Settings popup
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── content/                # Page injection
│   ├── content.js
│   └── content.css
├── background/             # API handling
│   └── service-worker.js
└── icons/                  # Extension icons
```

## Why Geoapify?

Google Maps API requires a credit card even for the free tier. Geoapify offers:
- Truly free tier (3,000 requests/day)
- No credit card required
- Good transit data coverage
- Simple API

## License

MIT
