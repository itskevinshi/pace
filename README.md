# Pace - StreetEasy Commute Times

Pace is a browser extension that automatically calculates and displays public transit commute times directly on StreetEasy apartment listings. It helps you make better decisions by showing you exactly how long it will take to get to work from any apartment you're viewing.

## Features

- **Instant Commute Calculation**: Automatically detects the apartment address and calculates the commute time to your configured work address.
- **Seamless Integration**: Displays the commute time prominently on the listing page.
- **Smart Address Search**: Includes an address autocomplete feature to easily find and set your work location.
- **Privacy Focused**: Your API key and address are stored locally in your browser.

### See it in action

**View commute times directly on listings:**

<p align="center">
  <img src="images/listing_widget_demo.png" width="600">
</p>

**Smart address autofill:**

<p align="center">
  <img src="images/work_address_input_autofill_demo.png" width="400">
</p>

## Installation

Since this extension is not yet in the Chrome Web Store, you can install it in Developer Mode:

1.  Clone or download this repository to your computer.
2.  Open Chrome and navigate to `chrome://extensions/`.
3.  Enable **Developer mode** in the top right corner.
4.  Click **Load unpacked**.
5.  Select the folder where you saved this repository (the folder containing `manifest.json`).

## Configuration

To use Pace, you need a free API key from Geoapify (free, no credit card required).

<details>
<summary><strong>📋 Click to expand setup instructions</strong></summary>

### 1. Get your free API Key
Open the Pace extension popup and click on **"Get free API key"**.

<p align="center">
  <img src="images/1_click_get_free_api_key.png" width="400">
</p>

### 2. Register an account
Sign up for a free account on Geoapify.

<p align="center">
  <img src="images/2_register_geoapify_account.png" width="500">
</p>

### 3. Create a project
Once logged in, click on **"Create a project"** in the dashboard.

<p align="center">
  <img src="images/3_click_create_a_project.png" width="500">
</p>

### 4. Name your project
Give your project a name (e.g., "Pace Extension") and click OK.

<p align="center">
  <img src="images/4_name_project.png" width="400">
</p>

### 5. Copy your API Key
Copy the generated API Key from the dashboard.

<p align="center">
  <img src="images/5_copy_api_key.png" width="500">
</p>

### 6. Enter API Key
Paste the API Key into the Pace extension settings.

<p align="center">
  <img src="images/6_paste_api_key_into_pace_extension.png" width="400">
</p>

### 7. Set Work Address
Start typing your work address and select it from the dropdown menu.

<p align="center">
  <img src="images/7_search_or_type_work_address.png" width="400">
</p>

### 8. Save Settings
Click **"Save Settings"**. You're all set! Refresh any StreetEasy listing page to see your commute times.

<p align="center">
  <img src="images/8_save_settings.png" width="400">
</p>

</details>

## Technologies Used

- **JavaScript (ES6+)**: Core logic for the extension.
- **Geoapify API**: Used for address geocoding and public transit routing.
- **Chrome Extension API**: Manifest V3, Storage API, Scripting.
- **HTML/CSS**: Popup interface and content injection styling.

## License

[MIT](LICENSE)
