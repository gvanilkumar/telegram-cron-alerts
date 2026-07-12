# AuraVigil Setup Guide

This guide provides step-by-step instructions to configure and deploy **AuraVigil** for both local development and serverless cloud execution via GitHub Actions.

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
6. [GitHub Actions Cloud Deployment](#6-github-actions-cloud-deployment)

---

## 1. Prerequisites
Ensure you have the following installed on your machine:
* **Node.js** (v20 or higher)
* **Git** (configured on your system)
* A **GitHub** account

---

## 2. Local Setup & Dashboard

AuraVigil features a local dashboard to easily manage your task schedules, settings, and credentials.

### Step 1: Clone the Repository
Clone your project repository and navigate into the root directory:
```bash
git clone <your-repository-url>
cd telegram-cron-alerts
```

### Step 2: Install Dependencies
Install all package dependencies for the backend and the frontend:
```bash
# Install backend dependencies
npm install

# Install frontend UI dependencies
cd frontend
npm install
cd ..
```

### Step 3: Run the Local Development Server
Start both the Node.js API server and the React frontend concurrently:
```bash
npm run dev
```
* The backend API server will run on: `http://localhost:3001`
* The frontend dashboard will open on: `http://localhost:5173` (or the next available port)

---

## 3. Notification Channels Setup

AuraVigil supports sending alerts to multiple channels simultaneously. Configure one or more of the following:

### Telegram Bot
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Start a chat and send `/newbot`. Follow the prompts to create your bot and copy the **HTTP API Token** (e.g., `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
3. Add the bot to your private group, public channel, or start a direct message with it.
4. Obtain your **Chat ID**:
   - Send a message in the chat where you added the bot.
   - Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in your browser.
   - Locate the `"chat"` object in the JSON response and copy the `"id"` (e.g., `-100123456789` for a group or channel, or a positive integer for a direct message).
5. Enter these credentials in the **Settings** panel of the AuraVigil local dashboard.

### Discord Webhook
1. Open Discord, go to your server settings, and select **Integrations** > **Webhooks**.
2. Click **Create Webhook**, customize the name and target channel, and click **Copy Webhook URL**.
3. Add this Webhook URL to the **Settings** panel under the Discord section.

### Slack Webhook
1. Go to [Slack API: Apps](https://api.slack.com/apps) and create a new Slack App.
2. Under **Features**, enable **Incoming Webhooks** and click **Add New Webhook to Workspace**.
3. Select your target channel, authorize, and copy the generated Webhook URL.
4. Add this Webhook URL to the **Settings** panel under the Slack section.

---

## 4. AI Model Providers Setup

To run AI-based scraper tasks, you need an API key from one of the supported model providers. Enter the key and configure your preferences in the **Settings** tab.

| Provider | Default Model | API Key Prefix | Description |
| :--- | :--- | :--- | :--- |
| **Gemini** | `gemini-2.5-flash` | `AIzaSy...` | Default out-of-the-box provider. Recommended. |
| **Groq** | `groq/compound` | `gsk_...` | Extremely fast. Compound model includes built-in Google Search capability. |
| **Cerebras** | `gpt-oss-120b` | `cbs-...` / `csk-...` | Highly performant open-source model execution. |
| **OpenAI** | `gpt-4o-mini` | `sk-...` | Industry standard OpenAI models. |
| **Custom** | User Configured | Varies | Use any OpenAI-compatible API endpoint (e.g., Local LLMs, Ollama, OpenRouter). |

> [!NOTE]
> If you set the provider to **Auto**, AuraVigil automatically detects which provider to use based on the format of the API key you supply.

---

## 5. Google Sheets Cloud Logging Setup

To offload task execution logs from Git commits and store them in the cloud, you can connect a Google Sheet.

### Step 1: Create a Google Cloud Service Account
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or use an existing one).
3. Navigate to **IAM & Admin** > **Service Accounts**.
4. Click **Create Service Account**, give it a name (e.g. `auravigil-logger`), and click **Create and Continue**.
5. Skip role assignment and click **Done**.
6. Select the newly created service account, go to the **Keys** tab, click **Add Key** > **Create New Key**, select **JSON**, and download the file. **Keep this file secure!**

### Step 2: Enable the Google Sheets API
1. In the Google Cloud Console, navigate to the **API Library**.
2. Search for **Google Sheets API** and click **Enable**.

### Step 3: Set Up the Google Spreadsheet
1. Create a new Google Spreadsheet.
2. Copy the **Spreadsheet ID** from the URL (the string between `/d/` and `/edit` in `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`).
3. Share the Google Sheet with the Service Account email address (found in your downloaded JSON key file as `client_email`), granting it **Editor** permissions.

### Step 4: Configure AuraVigil settings
1. Open the AuraVigil Local Dashboard.
2. Go to **Settings** and toggle **Enable Google Sheets Logging**.
3. Paste the **Google Sheet ID**.
4. Paste the entire contents of the downloaded **Service Account JSON Key** file into the **Google Service Account JSON Key** text field.
   - *Note: The local server automatically base64-encodes this key before saving it to your `.env` file to prevent multi-line environment variables from breaking the environment file parser.*
5. Save settings.

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

