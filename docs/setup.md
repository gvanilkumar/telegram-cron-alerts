# AuraVigil Setup Guide

This guide walks you through setting up **AuraVigil** for both local testing and cloud execution. 

Don't worry—you don't need to host a database or pay for servers. Everything runs either locally on your machine or for free in the cloud on GitHub Actions.

---

## Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Local Setup & Dashboard](#2-local-setup--dashboard)
3. [Notification Channels Setup](#3-notification-channels-setup)
   - [Telegram Bot](#telegram-bot)
   - [Discord Webhook](#discord-webhook)
   - [Slack Webhook](#slack-webhook)
4. [AI Model Providers Setup](#4-ai-model-providers-setup)
5. [Google Sheets Cloud Logging Setup](#5-google-sheets-cloud-logging-setup)
6. [Cloud Deployment & Precision Scheduling](#6-cloud-deployment--precision-scheduling)

---

## 1. Prerequisites
Before getting started, make sure you have these installed:
* **Node.js** (v20 or higher)
* **Git** (configured on your system)
* A **GitHub** account

---

## 2. Local Setup & Dashboard

AuraVigil has a beautiful local dashboard where you can easily manage monitor tasks, adjust schedules, verify credentials, and view execution history.

### Step 1: Clone the Repository
Clone the project repository and move into the folder:
```bash
git clone <your-repository-url>
cd telegram-cron-alerts
```

### Step 2: Install Dependencies
Install all the package dependencies for both the backend server and the frontend client:
```bash
# Install backend dependencies
npm install

# Install frontend UI dependencies
cd frontend
npm install
cd ..
```

### Step 3: Run the Dashboard
Start the Node.js API server and the React frontend concurrently:
```bash
npm run dev
```
* The backend API server runs on: `http://localhost:3001`
* The frontend dashboard will open on: `http://localhost:5173` (or the next available port)

---

## 3. Notification Channels Setup

AuraVigil can push alerts to multiple channels at the same time. Here is how to configure each one:

### Telegram Bot
1. Open Telegram, search for [@BotFather](https://t.me/BotFather), and hit Start.
2. Send `/newbot` and follow the quick prompts to name your bot.
3. Copy the **HTTP API Token** (e.g., `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
4. Add your new bot to your private group, channel, or just open a direct chat with it.
5. Get your **Chat ID**:
   - Send a test message in the chat where you added the bot.
   - Go to `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in your browser.
   - Look for the `"chat"` block in the JSON response and copy the `"id"` (e.g., `-100123456789` for a group or channel, or a positive integer for a direct chat).
6. Enter both keys in the **Settings** tab of your local dashboard.

### Discord Webhook
1. Open Discord, open your server settings, and go to **Integrations** > **Webhooks**.
2. Click **Create Webhook**, pick a channel, and click **Copy Webhook URL**.
3. Add the Webhook URL to the **Settings** tab under the Discord section.

### Slack Webhook
1. Go to the [Slack API Apps Console](https://api.slack.com/apps) and create a new App.
2. Enable **Incoming Webhooks** under features, and click **Add New Webhook to Workspace**.
3. Select your target channel, authorize, and copy the Webhook URL.
4. Add the URL to the **Settings** tab under the Slack section.

---

## 4. AI Model Providers Setup

To run intelligent scraper monitors, you'll need an API key from one of the supported AI providers. Paste your key and choose your settings in the dashboard **Settings** tab.

| Provider | Default Model | API Key Format | Why use it? |
| :--- | :--- | :--- | :--- |
| **Gemini** | `gemini-2.5-flash` | `AIzaSy...` | Default out-of-the-box option. Free tier friendly. |
| **Groq** | `groq/compound` | `gsk_...` | Fast response speeds. Compound model includes built-in Google Search. |
| **Cerebras** | `gpt-oss-120b` | `cbs-...` / `csk-...` | Incredible speed for open-source model execution. |
| **OpenAI** | `gpt-4o-mini` | `sk-...` | High quality standard models. |
| **Custom** | User Configured | Varies | Use local engines (like Ollama) or other third-party API gateways. |

> [!NOTE]
> If you select **Auto** as your provider, AuraVigil dynamically detects which service to query based on the prefix of the API key you paste.

---

## 5. Google Sheets Cloud Logging Setup

If you don't want your Git commit log bloated with runtime reports, you can connect a Google Sheet to store execution history.

### Step 1: Create a Google Cloud Service Account
1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project and head to **IAM & Admin** > **Service Accounts**.
3. Click **Create Service Account**, give it a name (e.g., `auravigil-logger`), and hit **Create and Continue**.
4. Skip the optional role selection and click **Done**.
5. Select your new service account, go to the **Keys** tab, click **Add Key** > **Create New Key**, choose **JSON**, and download the file. **Keep this file private!**

### Step 2: Enable the Google Sheets API
1. In the Google Cloud Console, search for the **Google Sheets API** in the API Library.
2. Click **Enable**.

### Step 3: Share the Spreadsheet
1. Create a new Google Sheet.
2. Copy the **Spreadsheet ID** from the browser URL (the long string between `/d/` and `/edit`).
3. Share the Google Sheet with the Service Account email address (found as `client_email` inside your downloaded JSON key) and give it **Editor** access.

### Step 4: Configure Settings
1. Open the AuraVigil local dashboard.
2. Go to **Settings** and turn on **Enable Google Sheets Logging**.
3. Paste the **Google Sheet ID**.
4. Paste the entire contents of the downloaded **Service Account JSON Key** file into the **Google Service Account JSON Key** field.
   - *Note: The local dashboard automatically base64-encodes this key before saving it to your `.env` file to prevent multi-line format parsing errors.*
5. Save your settings.

---

## 6. Cloud Deployment & Precision Scheduling

AuraVigil uses GitHub Actions to run tasks in the cloud for free. However, because GitHub's native scheduled cron jobs are frequently throttled or delayed (often by 15-45 minutes), it is highly recommended to use an external scheduling trigger (like **Cron-Job.org**) to call the GitHub API. This ensures your alerts run exactly on time.

### Step 1: Configure Repository Permissions
GitHub Actions must be allowed to write changes (like task execution status and embedding data in `state.json`) back to your repository.
1. On GitHub, navigate to your repository.
2. Go to **Settings** > **Actions** > **General**.
3. Scroll down to **Workflow permissions**.
4. Select **Read and write permissions**.
5. Click **Save**.

### Step 2: Add Repository Secrets
Your API credentials must not be committed to Git. Instead, save them as GitHub Secrets:
1. Go to your repository settings on GitHub.
2. Select **Secrets and variables** > **Actions**.
3. Click **New repository secret** and add any configuration variables you use:

| Secret Name | Value Description |
| :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Your Telegram Bot token. |
| `TELEGRAM_CHAT_ID` | Your Telegram Chat/Channel ID. |
| `GEMINI_API_KEY` | Your primary AI provider API key (Gemini, Groq, Cerebras, etc.). |
| `DISCORD_WEBHOOK_URL` | Your Discord channel webhook. (Optional) |
| `SLACK_WEBHOOK_URL` | Your Slack channel webhook. (Optional) |
| `CUSTOM_API_ENDPOINT` | Custom OpenAI-compatible API root URL. (Optional) |
| `CUSTOM_AI_MODEL` | Custom OpenAI model name identifier. (Optional) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The Base64 encoded or raw string of the Google Service Account JSON. (Optional) |
| `GOOGLE_SHEET_ID` | Your Google Spreadsheet ID. (Optional) |

> [!TIP]
> If you configured Google Sheets logging using the local dashboard, you can open your local `.env` file and directly copy the `GOOGLE_SERVICE_ACCOUNT_KEY` (which is already encoded in Base64) to your GitHub repository secrets.

### Step 3: Trigger the First Run Manually
1. Go to the **Actions** tab of your repository on GitHub.
2. Click on the **Telegram Cron Alerts** workflow in the left sidebar.
3. Click the **Run workflow** dropdown, select the `main` branch, and click the green **Run workflow** button.
4. Verify the logs to confirm the runner is executing successfully.

### Step 4: Setup Precision Scheduling (External Cron Trigger)
To bypass GitHub Actions schedule delays and run tasks exactly on time:
1. **Create a GitHub Personal Access Token (PAT):**
   - Go to your GitHub account settings -> Developer Settings -> Personal access tokens -> Tokens (classic).
   - Generate a new token with **`repo`** and **`workflow`** scopes. Copy and save the token.
2. **Create a free account on [Cron-Job.org](https://cron-job.org/).**
3. **Configure a new Cron Job:**
   - **Title:** `AuraVigil Trigger`
   - **Address (URL):** `https://api.github.com/repos/YOUR_USERNAME/YOUR_REPOSITORY/actions/workflows/scheduler.yml/dispatches`
     *(Replace `YOUR_USERNAME` and `YOUR_REPOSITORY` with your actual repository owner and name. The exact URL is pre-filled for you in your local dashboard Settings tab).*
   - **Request Method:** `POST`
   - **Request Headers:**
     - `Authorization: Bearer YOUR_GITHUB_PAT`
     - `Accept: application/vnd.github.v3+json`
     - `User-Agent: Cron-Job-Trigger`
   - **Request Body (JSON):**
     - `{"ref": "main"}`
   - **Schedule:** Choose your desired schedule frequency (e.g. every 5 minutes, 15 minutes, or hourly).
4. Save the cron job. Cron-Job.org will now hit the GitHub API on schedule, which triggers GitHub Actions to run `runner.js` immediately with zero queue delays.
