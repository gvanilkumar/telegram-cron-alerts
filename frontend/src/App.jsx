import React, { useState, useEffect, useCallback } from 'react';

// Dynamic model picker: fetches models live from the selected provider
function DynamicModelPicker({ provider, apiKey, savedApiKey, endpoint, value, onChange }) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fetched, setFetched] = useState(false);

  const fetchModels = useCallback(async () => {
    const key = apiKey || savedApiKey;
    if (!key || key === '(saved)' && !apiKey) {
      // Use saved key on server side — still call the endpoint
    }
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ provider });
      if (apiKey) params.set('key', apiKey);
      if (endpoint) params.set('endpoint', endpoint);
      const res = await fetch(`/api/ai/models?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load models');
      setModels(data.models || []);
      setFetched(true);
      // Auto-select first if current value not in list
      if (data.models?.length && !data.models.find(m => m.id === value)) {
        onChange(data.models[0].id);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [provider, apiKey, endpoint]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const label = provider === 'groq' ? 'Groq Model' : provider === 'openai' ? 'OpenAI Model' : 'Model';

  return (
    <div className="form-group">
      <label htmlFor="dynamicModel" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {label}
        <button
          type="button"
          onClick={fetchModels}
          disabled={loading}
          style={{
            background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer',
            fontSize: '0.8rem', color: 'var(--accent)', padding: '0 4px',
            opacity: loading ? 0.5 : 1
          }}
          title="Refresh model list"
        >
          {loading ? '⏳' : '🔄'} {loading ? 'Loading…' : 'Refresh'}
        </button>
      </label>

      {error && (
        <div style={{ color: '#f87171', fontSize: '0.82rem', marginBottom: '0.4rem' }}>
          ⚠️ {error}
        </div>
      )}

      {loading && !fetched ? (
        <div className="form-control" style={{ color: 'var(--text-dark)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span> Fetching models from API…
        </div>
      ) : models.length > 0 ? (
        <>
          <select
            id="dynamicModel"
            className="form-control"
            value={value}
            onChange={e => onChange(e.target.value)}
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.name || m.id}</option>
            ))}
          </select>
          {value?.startsWith('groq/compound') && (
            <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
              ✨ Compound models search the web automatically — no URL needed in tasks.
            </small>
          )}
        </>
      ) : fetched ? (
        <div style={{ color: 'var(--text-dark)', fontSize: '0.85rem' }}>
          No models found. Enter your API key above and click 🔄 Refresh.
        </div>
      ) : null}
    </div>
  );
}


export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [tasks, setTasks] = useState([]);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({
    credentialsConfigured: {},
    masked: {},
    autoSync: false
  });
  
  // Loading and action states
  const [loading, setLoading] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [toast, setToast] = useState(null);
  
  // Task form state
  const [editingTask, setEditingTask] = useState(null);
  const [taskForm, setTaskForm] = useState({
    name: '',
    type: 'ai',
    prompt: '',
    schedule: '5m',
    url: '',
    channels: ['telegram'],
    deduplicate: false,
    threshold: 0.90
  });

  // Settings credentials form state
  const [settingsForm, setSettingsForm] = useState({
    telegramBotToken: '',
    telegramChatId: '',
    geminiApiKey: '',
    discordWebhookUrl: '',
    slackWebhookUrl: '',
    customApiEndpoint: '',
    customAiModel: '',
    timezone: '',
    autoSync: false,
    aiProvider: 'auto',
    groqModel: 'groq/compound'
  });

  // Live cron validation states
  const [cronValidation, setCronValidation] = useState({ valid: true, error: null, nextRuns: [] });
  const [validatingCron, setValidatingCron] = useState(false);

  // GitHub Dispatch testing states
  const [githubPat, setGithubPat] = useState('');
  const [testingDispatch, setTestingDispatch] = useState(false);

  // UX Copy states
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedBody, setCopiedBody] = useState(false);

  // Expandable Log state
  const [expandedLogId, setExpandedLogId] = useState(null);

  // Copy helper
  const handleCopy = (elementId, type) => {
    const copyText = document.getElementById(elementId);
    if (!copyText) return;
    copyText.select();
    navigator.clipboard.writeText(copyText.value);
    
    if (type === 'url') {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1500);
    } else if (type === 'body') {
      setCopiedBody(true);
      setTimeout(() => setCopiedBody(false), 1500);
    }
  };

  // Scraper Preview & Alert Simulation states
  const [previewingScrape, setPreviewingScrape] = useState(false);
  const [scrapedText, setScrapedText] = useState('');
  const [simulatingAlert, setSimulatingAlert] = useState(false);
  const [simulatedAlert, setSimulatedAlert] = useState('');

  const handlePreviewScrape = async () => {
    if (!taskForm.url) return;
    setPreviewingScrape(true);
    setScrapedText('');
    showToast('Fetching and cleaning webpage text...', 'success');
    try {
      const res = await fetch('/api/scrape/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: taskForm.url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch preview');
      setScrapedText(data.text);
      showToast('Scrape preview retrieved successfully!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setPreviewingScrape(false);
    }
  };

  const handleSimulateAlert = async () => {
    if (!taskForm.prompt) return;
    setSimulatingAlert(true);
    setSimulatedAlert('');
    showToast('Simulating alert execution...', 'success');
    try {
      const res = await fetch('/api/prompt/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: taskForm.url,
          prompt: taskForm.prompt,
          type: taskForm.type,
          name: taskForm.name
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to simulate alert');
      setSimulatedAlert(data.alertMessage);
      showToast('Simulation complete!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSimulatingAlert(false);
    }
  };

  // Fetch initial data
  useEffect(() => {
    fetchTasks();
    fetchLogs();
    fetchSettings();
  }, []);

  // Toast auto-dismiss
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Live cron validation effect
  useEffect(() => {
    const isPreset = ['5m', '15m', '1h', '5h', 'daily', 'weekly', 'monthly'].includes(taskForm.schedule);
    if (isPreset) {
      setCronValidation({ valid: true, error: null, nextRuns: [] });
      return;
    }

    const validateCron = async () => {
      setValidatingCron(true);
      try {
        const tz = settingsForm.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const res = await fetch(`/api/cron/validate?expr=${encodeURIComponent(taskForm.schedule)}&tz=${encodeURIComponent(tz)}`);
        const data = await res.json();
        if (data.valid) {
          setCronValidation({ valid: true, error: null, nextRuns: data.nextRuns });
        } else {
          setCronValidation({ valid: false, error: data.error, nextRuns: [] });
        }
      } catch (err) {
        setCronValidation({ valid: false, error: err.message, nextRuns: [] });
      } finally {
        setValidatingCron(false);
      }
    };

    const delayDebounce = setTimeout(validateCron, 500);
    return () => clearTimeout(delayDebounce);
  }, [taskForm.schedule, settingsForm.timezone]);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
  };

  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) throw new Error('Failed to load tasks');
      const data = await res.json();
      setTasks(data);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      if (!res.ok) throw new Error('Failed to load logs');
      const data = await res.json();
      setLogs(data);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Failed to load settings');
      const data = await res.json();
      setSettings(data);
      setSettingsForm({
        telegramBotToken: '',
        telegramChatId: '',
        geminiApiKey: '',
        discordWebhookUrl: '',
        slackWebhookUrl: '',
        customApiEndpoint: data.customApiEndpoint || '',
        customAiModel: data.customAiModel || '',
        timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        autoSync: data.autoSync,
        aiProvider: data.aiProvider || 'auto',
        groqModel: data.groqModel || 'groq/compound'
      });
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Task Handlers
  const handleTaskFormChange = (e) => {
    const { name, value, type, checked } = e.target;
    const val = type === 'checkbox' ? checked : value;
    setTaskForm(prev => ({ ...prev, [name]: val }));
  };

  const startEditTask = (task) => {
    setEditingTask(task);
    setTaskForm({
      name: task.name,
      type: task.type,
      prompt: task.prompt,
      schedule: task.schedule,
      url: task.url || '',
      channels: task.channels || ['telegram'],
      deduplicate: !!task.deduplicate,
      threshold: task.threshold !== undefined ? task.threshold : 0.90
    });
  };

  const cancelEditTask = () => {
    setEditingTask(null);
    setTaskForm({ name: '', type: 'ai', prompt: '', schedule: '5m', url: '', channels: ['telegram'], deduplicate: false, threshold: 0.90 });
  };

  const handleSaveTask = async (e) => {
    e.preventDefault();
    if (!taskForm.name || !taskForm.prompt) {
      showToast('Please fill out all fields', 'error');
      return;
    }

    setLoading(true);
    try {
      const url = editingTask ? `/api/tasks/${editingTask.id}` : '/api/tasks';
      const method = editingTask ? 'PUT' : 'POST';
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskForm)
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to save task');
      }

      const result = await res.json();
      showToast(
        editingTask 
          ? `Task updated successfully. ${result.sync?.synced ? 'Synced to Git.' : ''}`
          : `Task created successfully. ${result.sync?.synced ? 'Synced to Git.' : ''}`
      );
      
      cancelEditTask();
      fetchTasks();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTask = async (id) => {
    if (!window.confirm('Are you sure you want to delete this alert task?')) return;
    
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete task');
      const result = await res.json();
      showToast(`Task deleted successfully. ${result.sync?.synced ? 'Synced to Git.' : ''}`);
      fetchTasks();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleToggleActive = async (task) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !task.active })
      });
      if (!res.ok) throw new Error('Failed to toggle status');
      const result = await res.json();
      showToast(`Task ${!task.active ? 'activated' : 'deactivated'}. ${result.sync?.synced ? 'Synced to Git.' : ''}`);
      fetchTasks();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleRunTaskNow = async (id) => {
    setLoading(true);
    showToast('Executing task and sending alert...', 'success');
    try {
      const res = await fetch(`/api/tasks/${id}/run`, { method: 'POST' });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Execution failed');
      }
      showToast('Alert sent successfully to your active channels!');
      fetchLogs();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleTestDiscord = async () => {
    setLoading(true);
    showToast('Sending test Discord alert...', 'success');
    try {
      const res = await fetch('/api/test-discord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordWebhookUrl: settingsForm.discordWebhookUrl })
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Test failed');
      }
      showToast('Test message sent to Discord!');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleTestSlack = async () => {
    setLoading(true);
    showToast('Sending test Slack alert...', 'success');
    try {
      const res = await fetch('/api/test-slack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slackWebhookUrl: settingsForm.slackWebhookUrl })
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Test failed');
      }
      showToast('Test message sent to Slack!');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleTestDispatch = async () => {
    if (!githubPat) {
      showToast('Please enter your GitHub Personal Access Token (PAT) first.', 'error');
      return;
    }
    setTestingDispatch(true);
    try {
      const res = await fetch('/api/test-dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pat: githubPat })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to trigger test dispatch');
      showToast('⚡ Success! Test cloud run triggered on GitHub Actions!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setTestingDispatch(false);
    }
  };

  const [enhancingPrompt, setEnhancingPrompt] = useState(false);
  const [promptTips, setPromptTips] = useState([]);

  // Real-time client-side prompt advisor
  useEffect(() => {
    if (taskForm.type !== 'ai') {
      setPromptTips([]);
      return;
    }
    const text = taskForm.prompt || '';
    const tips = [];
    
    if (text.length === 0) {
      tips.push("Describe what you want the AI to watch for (e.g. price changes, release announcements).");
    } else {
      if (text.length < 25) {
        tips.push("Prompt is a bit short. Add more detail so the AI extracts accurate information.");
      }
      if (!text.toLowerCase().includes('no update') && !text.toLowerCase().includes('skip') && !text.toLowerCase().includes('ignore')) {
        tips.push("Add a fallback condition (e.g. 'If nothing has changed, output \"no update\"') to make deduplication work perfectly.");
      }
      if (!text.toLowerCase().includes('sentence') && !text.toLowerCase().includes('bullet') && !text.toLowerCase().includes('limit') && !text.toLowerCase().includes('brief')) {
        tips.push("Specify length or format limits (e.g. 'summarize in 3 bullet points' or 'keep it under 3 sentences') for cleaner notifications.");
      }
      if (taskForm.url && !text.toLowerCase().includes('page') && !text.toLowerCase().includes('context') && !text.toLowerCase().includes('site')) {
        tips.push("Reference the source (e.g. 'Scan this page context...') so the AI knows to inspect the scraped HTML text.");
      }
    }
    setPromptTips(tips);
  }, [taskForm.prompt, taskForm.type, taskForm.url]);

  const handleEnhancePrompt = async () => {
    if (!taskForm.prompt) return;
    setEnhancingPrompt(true);
    showToast('Optimizing your prompt using AI...', 'success');
    try {
      const res = await fetch('/api/prompt/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: taskForm.prompt, url: taskForm.url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to enhance prompt');
      setTaskForm(prev => ({ ...prev, prompt: data.enhancedPrompt }));
      showToast('✨ Prompt optimized successfully!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setEnhancingPrompt(false);
    }
  };

  const injectPromptTemplate = (templateText) => {
    setTaskForm(prev => ({ ...prev, prompt: templateText }));
    showToast('Template loaded! You can now customize it.', 'success');
  };

  const handleChannelCheckboxChange = (channel) => {
    setTaskForm(prev => {
      const currentChannels = prev.channels || ['telegram'];
      if (currentChannels.includes(channel)) {
        if (currentChannels.length === 1) return prev; // Keep at least one channel
        return { ...prev, channels: currentChannels.filter(ch => ch !== channel) };
      } else {
        return { ...prev, channels: [...currentChannels, channel] };
      }
    });
  };

  // Settings Handlers
  const handleSettingsChange = (e) => {
    const { name, value, type, checked } = e.target;
    setSettingsForm(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsForm)
      });
      if (!res.ok) throw new Error('Failed to save settings');
      showToast('Settings saved successfully.');
      fetchSettings();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleTestTelegram = async () => {
    setLoading(true);
    showToast('Sending test Telegram alert...', 'success');
    try {
      const res = await fetch('/api/test-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramBotToken: settingsForm.telegramBotToken,
          telegramChatId: settingsForm.telegramChatId
        })
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Test failed');
      }
      showToast('Test message sent! Check your Telegram App.');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGitSync = async () => {
    setGitLoading(true);
    showToast('Syncing configurations with GitHub...', 'success');
    try {
      const res = await fetch('/api/git/sync', { method: 'POST' });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Sync failed');
      }
      const data = await res.json();
      showToast(data.message);
      fetchTasks();
      fetchLogs();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setGitLoading(false);
    }
  };

  const handleShutdown = async () => {
    if (!window.confirm('Shut down the configuration UI server? This webpage will stop responding.')) return;
    try {
      await fetch('/api/shutdown', { method: 'POST' });
      showToast('Server has shut down. You can close this tab now.', 'error');
    } catch (err) {
      showToast('Successfully sent shutdown request.', 'success');
    }
  };

  const getScheduleLabel = (val) => {
    const labels = {
      '5m': 'Every 5 Minutes',
      '15m': 'Every 15 Minutes',
      '1h': 'Every Hour',
      '5h': 'Every 5 Hours',
      'daily': 'Daily',
      'weekly': 'Weekly',
      'monthly': 'Monthly'
    };
    return labels[val] || val;
  };

  const totalMonitors = tasks.length;
  const activeSchedules = tasks.filter(t => t.active).length;
  const successLogsCount = logs.filter(l => l.status === 'success' || l.status === 'skipped').length;
  const healthPct = logs.length > 0 ? Math.round((successLogsCount / logs.length) * 100) : 100;
  const savedCount = logs.filter(l => l.status === 'skipped').length;

  return (
    <div className="app-container">
      {/* Toast Alert */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          <span>{toast.type === 'success' ? '✔' : '❌'}</span>
          <span>{toast.message}</span>
        </div>
      )}

      {/* Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-icon" style={{ display: 'flex', alignItems: 'center' }}>
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ filter: 'drop-shadow(0 0 8px var(--accent-cyan))' }}>
              <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 17L12 22L22 17" stroke="var(--accent-purple)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 12L12 17L22 12" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="12" cy="7" r="2" fill="var(--text-main)" />
            </svg>
          </div>
          <div className="logo-text">
            <h1 style={{ background: 'linear-gradient(135deg, var(--text-main) 30%, var(--accent-cyan) 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontWeight: '800', letterSpacing: '0.5px', margin: 0 }}>
              AuraVigil
            </h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', letterSpacing: '0.2px', margin: 0 }}>
              Serverless Web Sentinels & AI Alert Scheduler
            </p>
          </div>
        </div>

        <div className="server-control">
          <button 
            className="btn btn-secondary flex-gap-1" 
            onClick={handleGitSync} 
            disabled={gitLoading}
          >
            <span className={gitLoading ? 'spin-icon' : ''}>🔄</span>
            <span>{gitLoading ? 'Syncing...' : 'Sync GitHub'}</span>
          </button>
          
          <button className="btn btn-danger" onClick={handleShutdown}>
            Shut down UI
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="mb-4" style={{ display: 'flex', justifyContent: 'center' }}>
        <div className="nav-tabs">
          <button 
            className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
          <button 
            className={`tab-btn ${activeTab === 'tasks' ? 'active' : ''}`}
            onClick={() => setActiveTab('tasks')}
          >
            Tasks ({tasks.length})
          </button>
          <button 
            className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            Logs History
          </button>
          <button 
            className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            Settings & Setup
          </button>
        </div>
      </div>

      {/* Content Container */}
      <main>
        {/* --- DASHBOARD TAB --- */}
        {activeTab === 'dashboard' && (
          <div>
            <div className="metrics-ribbon">
              <div className="metric-card">
                <div className="metric-value">{totalMonitors}</div>
                <div className="metric-label">📁 Total Monitors</div>
              </div>
              
              <div className="metric-card">
                <div className="metric-value">{activeSchedules}</div>
                <div className="metric-label">⏰ Active Schedules</div>
              </div>

              <div className="metric-card">
                <div className="metric-value">{healthPct}%</div>
                <div className="metric-label">💚 Cloud Health Rate</div>
              </div>

              <div className="metric-card">
                <div className="metric-value">{savedCount}</div>
                <div className="metric-label">🛡️ AI Duplicate Blocked</div>
              </div>
            </div>

            <div className="grid-2col">
              <div className="glass-card">
                <h2 className="section-title">Credentials Configured</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginTop: '0.5rem' }}>
                  <div className="flex-between">
                    <span>Telegram Bot Token:</span>
                    <span className={`badge ${settings.credentialsConfigured.telegramBotToken ? 'badge-active' : 'badge-inactive'}`}>
                      {settings.credentialsConfigured.telegramBotToken ? 'Configured' : 'Missing'}
                    </span>
                  </div>
                  <div className="flex-between">
                    <span>Telegram Chat ID:</span>
                    <span className={`badge ${settings.credentialsConfigured.telegramChatId ? 'badge-active' : 'badge-inactive'}`}>
                      {settings.credentialsConfigured.telegramChatId ? 'Configured' : 'Missing'}
                    </span>
                  </div>
                  <div className="flex-between">
                    <span>Gemini API Key:</span>
                    <span className={`badge ${settings.credentialsConfigured.geminiApiKey ? 'badge-active' : 'badge-inactive'}`}>
                      {settings.credentialsConfigured.geminiApiKey ? 'Configured' : 'Missing'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="glass-card">
                <h2 className="section-title">Recent Run Log</h2>
                {logs.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.5rem' }}>No execution logs available yet.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
                    {logs.slice(0, 3).map((log, index) => (
                      <div key={index} className="flex-between" style={{ paddingBottom: '0.5rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <div>
                          <strong style={{ fontSize: '0.9rem' }}>{log.taskName}</strong>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {new Date(log.timestamp).toLocaleString()}
                          </div>
                        </div>
                        <span className={log.status === 'success' ? 'status-success' : 'status-error'}>
                          {log.status.toUpperCase()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* --- TASKS TAB --- */}
        {activeTab === 'tasks' && (
          <div className="tasks-container">
            {/* Task list card */}
            <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--glass-border)' }}>
                <h2 className="section-title" style={{ margin: 0 }}>Configured Tasks</h2>
              </div>
              {tasks.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                  No tasks configured. Use the form to create your first scheduled alert!
                </div>
              ) : (
                <div>
                  {tasks.map(task => (
                    <div key={task.id} className="task-item">
                      <div className="task-details">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span className="task-title">{task.name}</span>
                          <span className={`badge ${task.active ? 'badge-active' : 'badge-inactive'}`}>
                            {task.active ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                        <div className="flex-gap-1 mt-1" style={{ flexWrap: 'wrap' }}>
                          <span className="task-schedule-tag">{getScheduleLabel(task.schedule)}</span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-dark)' }}>
                            [{task.type.toUpperCase()}]
                          </span>
                          {(task.channels || ['telegram']).map(ch => (
                            <span key={ch} style={{ 
                              fontSize: '0.7rem', 
                              padding: '0.1rem 0.35rem', 
                              borderRadius: '4px',
                              background: ch === 'telegram' ? 'rgba(6,182,212,0.1)' : ch === 'discord' ? 'rgba(139,92,246,0.1)' : 'rgba(16,185,129,0.1)',
                              color: ch === 'telegram' ? 'var(--accent-cyan)' : ch === 'discord' ? 'var(--accent-purple)' : 'var(--color-success)',
                              border: `1px solid ${ch === 'telegram' ? 'rgba(6,182,212,0.2)' : ch === 'discord' ? 'rgba(139,92,246,0.2)' : 'rgba(16,185,129,0.2)'}`
                            }}>
                              {ch.toUpperCase()}
                            </span>
                          ))}
                          {task.deduplicate && (
                            <span style={{ 
                              fontSize: '0.75rem', 
                              padding: '0.1rem 0.35rem', 
                              borderRadius: '4px',
                              background: 'rgba(239,68,68,0.1)',
                              color: '#f87171',
                              border: '1px solid rgba(239,68,68,0.2)'
                            }}>
                              DEDUPLICATE ({Math.round(task.threshold * 100)}%)
                            </span>
                          )}
                        </div>
                        {task.url && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '250px' }}>
                            🔗 <a href={task.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-cyan)', textDecoration: 'none' }}>{task.url}</a>
                          </div>
                        )}
                      </div>
                      
                      <div className="task-actions">
                        <button 
                          className="btn btn-secondary btn-icon" 
                          title="Run Now (Sends to all active channels)"
                          onClick={() => handleRunTaskNow(task.id)}
                          disabled={loading}
                        >
                          ⚡
                        </button>
                        <button 
                          className="btn btn-secondary btn-icon" 
                          title="Edit Task"
                          onClick={() => startEditTask(task)}
                        >
                          ✏️
                        </button>
                        <button 
                          className="btn btn-secondary btn-icon" 
                          title={task.active ? 'Deactivate' : 'Activate'}
                          onClick={() => handleToggleActive(task)}
                        >
                          👁‍🗨
                        </button>
                        <button 
                          className="btn btn-danger btn-icon" 
                          title="Delete Task"
                          onClick={() => handleDeleteTask(task.id)}
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Task Form Card */}
            <div className="glass-card">
              <h2 className="section-title">{editingTask ? 'Edit Alert Task' : 'Create Alert Task'}</h2>
              <form onSubmit={handleSaveTask}>
                <div className="form-group">
                  <label htmlFor="task-name">Task Name</label>
                  <input 
                    type="text" 
                    id="task-name"
                    name="name" 
                    className="form-control"
                    placeholder="e.g. Daily Tech News Summary"
                    value={taskForm.name}
                    onChange={handleTaskFormChange}
                    required
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="task-type">Execution Type</label>
                    <select 
                      id="task-type"
                      name="type" 
                      className="form-control"
                      value={taskForm.type}
                      onChange={handleTaskFormChange}
                    >
                      <option value="ai">AI Prompt Generator (Gemini)</option>
                      <option value="static">Static Text Alert (Plain Text)</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="task-schedule">Alert Frequency</label>
                    <select 
                      id="task-schedule"
                      name="schedule" 
                      className="form-control"
                      value={['5m', '15m', '1h', '5h', 'daily', 'weekly', 'monthly'].includes(taskForm.schedule) ? taskForm.schedule : 'custom'}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === 'custom') {
                          setTaskForm(prev => ({ ...prev, schedule: '*/15 * * * *' })); // default custom cron
                        } else {
                          setTaskForm(prev => ({ ...prev, schedule: val }));
                        }
                      }}
                    >
                      <option value="5m">Every 5 Minutes</option>
                      <option value="15m">Every 15 Minutes</option>
                      <option value="1h">Every Hour</option>
                      <option value="5h">Every 5 Hours</option>
                      <option value="daily">Daily at 9:00 AM</option>
                      <option value="weekly">Weekly (Sunday 9:00 AM)</option>
                      <option value="monthly">Monthly (1st at 9:00 AM)</option>
                      <option value="custom">Custom Cron Expression...</option>
                    </select>
                  </div>
                </div>

                {!['5m', '15m', '1h', '5h', 'daily', 'weekly', 'monthly'].includes(taskForm.schedule) && (
                  <div className="form-group" style={{ marginTop: '0.75rem' }}>
                    <label htmlFor="task-custom-cron">Custom Cron Expression</label>
                    <input 
                      type="text" 
                      id="task-custom-cron"
                      name="schedule" 
                      className="form-control"
                      placeholder="e.g. */10 9-17 * * 1-5"
                      value={taskForm.schedule}
                      onChange={handleTaskFormChange}
                      required
                    />
                    <small style={{ display: 'block', marginTop: '0.35rem' }}>
                      {validatingCron ? (
                        <span style={{ color: 'var(--text-dark)' }}>⏳ Validating schedule...</span>
                      ) : cronValidation.valid ? (
                        <span style={{ color: 'var(--color-success)' }}>
                          ✓ Valid Cron. Next local runs: 
                          <ul style={{ margin: '0.2rem 0 0 1rem', padding: 0 }}>
                            {cronValidation.nextRuns.map((time, idx) => (
                              <li key={idx}>{new Date(time).toLocaleString()}</li>
                            ))}
                          </ul>
                        </span>
                      ) : (
                        <span style={{ color: '#ef4444' }}>✗ Invalid Cron: {cronValidation.error}</span>
                      )}
                    </small>
                  </div>
                )}

                {taskForm.type === 'ai' && (
                  <div className="form-group">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label htmlFor="task-url" style={{ margin: 0 }}>Target Webpage URL to Scrape (Optional)</label>
                      {taskForm.url && (
                        <button 
                          type="button" 
                          className="btn btn-secondary" 
                          disabled={previewingScrape}
                          onClick={handlePreviewScrape}
                          style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem', margin: 0, textTransform: 'none' }}
                        >
                          {previewingScrape ? '⏳ Fetching...' : '🔍 Test Scrape'}
                        </button>
                      )}
                    </div>
                    <input 
                      type="url" 
                      id="task-url"
                      name="url" 
                      className="form-control"
                      style={{ marginTop: '0.35rem' }}
                      placeholder="e.g. https://www.moneycontrol.com/news/business/markets/"
                      value={taskForm.url}
                      onChange={handleTaskFormChange}
                    />
                    <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
                      If provided, the runner will fetch this page, clean the text content, and feed it to Gemini as live context.
                    </small>

                    {scrapedText && (
                      <div style={{ marginTop: '0.75rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                          <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--accent-cyan)' }}>📄 Extracted Page Text Preview:</span>
                          <button 
                            type="button" 
                            className="btn btn-secondary" 
                            style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem' }}
                            onClick={() => setScrapedText('')}
                          >
                            Close Preview
                          </button>
                        </div>
                        <pre className="code-block" style={{ maxHeight: '180px', overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>
                          {scrapedText}
                        </pre>
                      </div>
                    )}
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="task-prompt" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>
                      {taskForm.type === 'ai' 
                        ? 'AI Prompt Instructions (What should Gemini write?)' 
                        : 'Static Message Content (Text to send directly)'}
                    </span>
                    {taskForm.type === 'ai' && taskForm.prompt && (
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        disabled={enhancingPrompt || loading}
                        onClick={handleEnhancePrompt}
                        style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem', margin: 0, textTransform: 'none' }}
                      >
                        {enhancingPrompt ? '🪄 Optimizing...' : '🪄 Enhance with AI'}
                      </button>
                    )}
                  </label>
                  <textarea 
                    id="task-prompt"
                    name="prompt" 
                    className="form-control"
                    placeholder={taskForm.type === 'ai' 
                      ? "e.g. Search for news about SpaceX Starship launch today and summarize it in 3 bullet points." 
                      : "e.g. Drink water reminder! Take a 5-minute stretch walk away from your screen."}
                    value={taskForm.prompt}
                    onChange={handleTaskFormChange}
                    required
                  />
                  {promptTips.length > 0 && (
                    <div style={{ background: 'rgba(245, 158, 11, 0.08)', borderLeft: '3px solid #f59e0b', padding: '0.6rem 0.75rem', borderRadius: '4px', marginTop: '0.5rem', fontSize: '0.85rem' }}>
                      <span style={{ fontWeight: 'bold', color: '#d97706', display: 'block', marginBottom: '0.2rem' }}>💡 Real-time Suggestions:</span>
                      <ul style={{ margin: 0, paddingLeft: '1.25rem', color: 'var(--text-dark)' }}>
                        {promptTips.map((tip, idx) => (
                          <li key={idx} style={{ marginBottom: '0.25rem' }}>{tip}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {taskForm.type === 'ai' ? (
                  <div style={{ marginTop: '0.5rem', marginBottom: '1.25rem' }}>
                    <small style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.35rem', color: 'var(--text-dark)' }}>
                      💡 Quick AI Prompt Templates:
                    </small>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', textTransform: 'none' }}
                        onClick={() => injectPromptTemplate("Scan the page context and extract any news or updates about Tesla (TSLA). If TSLA stock price or market movement is mentioned, output a summary starting with '📈 Tesla Update:'. Keep it under 3 sentences. If there is no mention, output 'no update'.")}
                      >
                        📈 Stock/Crypto Monitor
                      </button>
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', textTransform: 'none' }}
                        onClick={() => injectPromptTemplate("Search for any announcements of new software versions, developer tools, or SDK releases on this page. If found, list the version name and key changes as bullet points. If nothing is new, output 'no update'.")}
                      >
                        🚀 Tech Releases
                      </button>
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', textTransform: 'none' }}
                        onClick={() => injectPromptTemplate("Extract the pricing plans and features from this page context. Write a clear notification listing the plan names, monthly prices, and any key feature changes. Be extremely concise. If nothing changed, output 'no update'.")}
                      >
                        💰 Competitor Pricing
                      </button>
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', textTransform: 'none' }}
                        onClick={() => injectPromptTemplate("Analyze this page for job listings matching 'React', 'Node.js', or 'Python'. For each match, output: Job Title, Company, and Location in bullet points. If no matching roles are found, output 'no update'.")}
                      >
                        💼 Job Board Scan
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: '0.5rem', marginBottom: '1.25rem' }}>
                    <small style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.35rem', color: 'var(--text-dark)' }}>
                      💡 Quick Message Presets:
                    </small>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', textTransform: 'none' }}
                        onClick={() => injectPromptTemplate("⏰ Hydration Check! Stand up, stretch, and drink a glass of water.")}
                      >
                        💧 Hydration Reminder
                      </button>
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', textTransform: 'none' }}
                        onClick={() => injectPromptTemplate("🚀 Crypto Alert: BTC has breached the daily resistance level! Check TradingView charts.")}
                      >
                        🪙 Price Alert
                      </button>
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', textTransform: 'none' }}
                        onClick={() => injectPromptTemplate("👥 Team Standup starting in 10 minutes. Prepare your tasks log.")}
                      >
                        👥 Meeting Notice
                      </button>
                    </div>
                  </div>
                )}

                <div className="form-group">
                  <label>Delivery Channels</label>
                  <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', margin: 0 }}>
                      <input 
                        type="checkbox" 
                        style={{ width: '16px', height: '16px' }}
                        checked={(taskForm.channels || ['telegram']).includes('telegram')}
                        onChange={() => handleChannelCheckboxChange('telegram')}
                      />
                      <span>Telegram</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', margin: 0 }}>
                      <input 
                        type="checkbox" 
                        style={{ width: '16px', height: '16px' }}
                        checked={(taskForm.channels || ['telegram']).includes('discord')}
                        onChange={() => handleChannelCheckboxChange('discord')}
                      />
                      <span>Discord Webhook</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', margin: 0 }}>
                      <input 
                        type="checkbox" 
                        style={{ width: '16px', height: '16px' }}
                        checked={(taskForm.channels || ['telegram']).includes('slack')}
                        onChange={() => handleChannelCheckboxChange('slack')}
                      />
                      <span>Slack Webhook</span>
                    </label>
                  </div>
                </div>

                {taskForm.type === 'ai' && (
                  <div className="form-group" style={{ marginTop: '1.25rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', margin: 0 }}>
                      <input 
                        type="checkbox" 
                        name="deduplicate"
                        style={{ width: '16px', height: '16px' }}
                        checked={!!taskForm.deduplicate}
                        onChange={handleTaskFormChange}
                      />
                      <span style={{ fontWeight: 'bold' }}>Deduplicate Alerts (Semantic AI Filter)</span>
                    </label>
                    <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
                      Uses neural embeddings (Gemini/OpenAI) or semantic distance to skip duplicate or very similar updates.
                    </small>

                    {taskForm.deduplicate && (
                      <div style={{ marginTop: '0.75rem', paddingLeft: '1.5rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                          <label htmlFor="task-threshold" style={{ margin: 0 }}>Similarity Threshold: <strong>{Math.round(taskForm.threshold * 100)}%</strong></label>
                        </div>
                        <input 
                          type="range" 
                          id="task-threshold"
                          name="threshold" 
                          min="0.50" 
                          max="0.99" 
                          step="0.01"
                          className="form-control"
                          style={{ padding: 0, height: 'auto', cursor: 'pointer' }}
                          value={taskForm.threshold}
                          onChange={handleTaskFormChange}
                        />
                        <div style={{ color: 'var(--accent-cyan)', fontSize: '0.8rem', fontWeight: 'bold', marginTop: '0.35rem' }}>
                          ⚡ {(() => {
                            const val = parseFloat(taskForm.threshold);
                            if (val >= 0.95) return "Strict (Only skips near-identical alerts)";
                            if (val >= 0.88) return "Standard (Recommended - matches similar topics)";
                            if (val >= 0.75) return "Balanced";
                            return "Loose (Any minor similarity skips delivery)";
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex-gap-2 mt-4" style={{ flexWrap: 'wrap' }}>
                  {taskForm.prompt && (
                    <button 
                      type="button" 
                      className="btn btn-secondary" 
                      disabled={simulatingAlert}
                      onClick={handleSimulateAlert}
                      style={{ flexGrow: 1 }}
                    >
                      {simulatingAlert ? '⏳ Simulating...' : '⚡ Simulate Alert'}
                    </button>
                  )}
                  <button 
                    type="submit" 
                    className="btn btn-primary" 
                    disabled={loading || (!['5m', '15m', '1h', '5h', 'daily', 'weekly', 'monthly'].includes(taskForm.schedule) && !cronValidation.valid)} 
                    style={{ flexGrow: 1 }}
                  >
                    {editingTask ? 'Update Task' : 'Create Task'}
                  </button>
                  {editingTask && (
                    <button type="button" className="btn btn-secondary" onClick={cancelEditTask}>
                      Cancel
                    </button>
                  )}
                </div>

                {simulatedAlert && (
                  <div style={{ marginTop: '1rem', background: 'rgba(139, 92, 246, 0.08)', border: '1px solid var(--accent-purple-glow)', padding: '1rem', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--accent-purple)' }}>✨ Simulated AI Alert Output:</span>
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem' }}
                        onClick={() => setSimulatedAlert('')}
                      >
                        Close Preview
                      </button>
                    </div>
                    <div style={{ fontSize: '0.9rem', color: 'var(--text-main)', whiteSpace: 'pre-wrap', lineHeight: '1.45' }}>
                      {simulatedAlert}
                    </div>
                  </div>
                )}
              </form>
            </div>
          </div>
        )}

        {/* --- LOGS TAB --- */}
        {activeTab === 'logs' && (
          <div className="glass-card">
            <div className="flex-between mb-3">
              <h2 className="section-title" style={{ margin: 0 }}>Execution Logs History</h2>
              <button className="btn btn-secondary btn-icon" title="Refresh Logs" onClick={fetchLogs}>
                🔄
              </button>
            </div>

            {logs.length === 0 ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                No executions logged yet. Add tasks and wait for GitHub Actions to trigger them, or run them manually.
              </div>
            ) : (
              <div className="logs-table-container">
                <table className="logs-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Task Name</th>
                      <th>Schedule</th>
                      <th>Status</th>
                      <th>Message Preview / Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log, index) => {
                      const logId = `${log.timestamp}-${log.taskId}`;
                      const isExpanded = expandedLogId === logId;
                      return (
                        <React.Fragment key={index}>
                          <tr className="log-row-header" onClick={() => setExpandedLogId(isExpanded ? null : logId)}>
                            <td>{new Date(log.timestamp).toLocaleString()}</td>
                            <td><strong>{log.taskName}</strong></td>
                            <td><span className="task-schedule-tag">{getScheduleLabel(log.schedule)}</span></td>
                            <td>
                              <span className={
                                log.status === 'success' ? 'status-success' : 
                                log.status === 'skipped' ? 'status-warning' : 
                                'status-error'
                              }>
                                {log.status.toUpperCase()}
                              </span>
                            </td>
                            <td style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '350px' }}>
                                {log.output}
                              </span>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>
                                {isExpanded ? '▲ Hide' : '▼ Inspect'}
                              </span>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={5} style={{ padding: 0 }}>
                                <div className="log-details-panel">
                                  <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                    <strong>Timestamp:</strong> <span>{new Date(log.timestamp).toString()}</span>
                                    <strong>Task ID:</strong> <span><code>{log.taskId}</code></span>
                                    <strong>Run Status:</strong> 
                                    <span>
                                      <span className={
                                        log.status === 'success' ? 'status-success' : 
                                        log.status === 'skipped' ? 'status-warning' : 
                                        'status-error'
                                      } style={{ display: 'inline-block', margin: 0 }}>
                                        {log.status.toUpperCase()}
                                      </span>
                                    </span>
                                  </div>
                                  <div style={{ marginTop: '0.75rem' }}>
                                    <strong>Full Log Output:</strong>
                                    <pre className="code-block" style={{ marginTop: '0.35rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.85rem' }}>
                                      {log.output}
                                    </pre>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* --- SETTINGS TAB --- */}
        {activeTab === 'settings' && (
          <div className="grid-2col">
            {/* Credentials Card */}
            <div className="glass-card">
              <h2 className="section-title">Local Credentials Settings</h2>
              <form onSubmit={handleSaveSettings}>
                <div className="form-group">
                  <label htmlFor="telegramBotToken">Telegram Bot Token</label>
                  <input 
                    type="password" 
                    id="telegramBotToken"
                    name="telegramBotToken" 
                    className="form-control"
                    placeholder={settings.masked.telegramBotToken || "Enter your Telegram Bot Token"}
                    value={settingsForm.telegramBotToken}
                    onChange={handleSettingsChange}
                  />
                  <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
                    Created via Telegram's @BotFather bot.
                  </small>
                </div>

                <div className="form-group">
                  <label htmlFor="telegramChatId">Telegram Chat ID</label>
                  <input 
                    type="text" 
                    id="telegramChatId"
                    name="telegramChatId" 
                    className="form-control"
                    placeholder={settings.masked.telegramChatId || "Enter your Telegram Chat ID"}
                    value={settingsForm.telegramChatId}
                    onChange={handleSettingsChange}
                  />
                  <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
                    Can be obtained via Telegram bots like @userinfobot.
                  </small>
                </div>

                <div className="form-group">
                  <label htmlFor="aiProvider">AI Model Provider</label>
                  <select 
                    id="aiProvider"
                    name="aiProvider" 
                    className="form-control"
                    value={settingsForm.aiProvider}
                    onChange={handleSettingsChange}
                  >
                    <option value="auto">Auto-Detect by Key Prefix (Default)</option>
                    <option value="gemini">Google Gemini AI</option>
                    <option value="groq">Groq Inference Engine</option>
                    <option value="cerebras">Cerebras Fast Inference</option>
                    <option value="openai">OpenAI (GPT Models)</option>
                    <option value="custom">Custom OpenAI-Compatible API</option>
                  </select>
                </div>

                {(settingsForm.aiProvider === 'groq' || settingsForm.aiProvider === 'openai' || settingsForm.aiProvider === 'custom') && (
                  <DynamicModelPicker
                    provider={settingsForm.aiProvider}
                    apiKey={settingsForm.geminiApiKey}
                    savedApiKey={settings.credentialsConfigured?.geminiApiKey ? '(saved)' : ''}
                    endpoint={settingsForm.customApiEndpoint}
                    value={settingsForm.groqModel}
                    onChange={(val) => setSettingsForm(prev => ({ ...prev, groqModel: val }))}
                  />
                )}

                <div className="form-group">
                  <label htmlFor="geminiApiKey">AI API Key (Gemini / Groq / OpenAI / Custom)</label>
                  <input 
                    type="password" 
                    id="geminiApiKey"
                    name="geminiApiKey" 
                    className="form-control"
                    placeholder={settings.masked.geminiApiKey || "Enter your AI API Key"}
                    value={settingsForm.geminiApiKey}
                    onChange={handleSettingsChange}
                  />
                  <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
                    Paste your API Key. The engine auto-detects Groq (starts with <code>gsk_</code>), OpenAI (starts with <code>sk-</code>), and Gemini.
                  </small>
                </div>

                <div className="form-group">
                  <label htmlFor="customApiEndpoint">Custom API Endpoint URL (Optional)</label>
                  <input 
                    type="url" 
                    id="customApiEndpoint"
                    name="customApiEndpoint" 
                    className="form-control"
                    placeholder="e.g. https://api.deepseek.com/v1"
                    value={settingsForm.customApiEndpoint}
                    onChange={handleSettingsChange}
                  />
                  <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
                    If you want to use other providers like DeepSeek, OpenRouter, Mistral, or a local LLM (Ollama).
                  </small>
                </div>

                <div className="form-group">
                  <label htmlFor="customAiModel">Custom AI Model Name (Optional)</label>
                  <input 
                    type="text" 
                    id="customAiModel"
                    name="customAiModel" 
                    className="form-control"
                    placeholder="e.g. deepseek-chat (defaults to gpt-4o-mini if endpoint is custom)"
                    value={settingsForm.customAiModel}
                    onChange={handleSettingsChange}
                  />
                  <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
                    The model identifier to query at your custom endpoint.
                  </small>
                </div>

                <div className="form-group">
                  <label htmlFor="discordWebhookUrl">Discord Webhook URL</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input 
                      type="password" 
                      id="discordWebhookUrl"
                      name="discordWebhookUrl" 
                      className="form-control"
                      placeholder={settings.masked.discordWebhookUrl || "Enter Discord Webhook URL"}
                      value={settingsForm.discordWebhookUrl}
                      onChange={handleSettingsChange}
                      style={{ flexGrow: 1 }}
                    />
                    <button type="button" className="btn btn-secondary" onClick={handleTestDiscord} disabled={loading} style={{ padding: '0.5rem 0.75rem', fontSize: '0.8rem' }}>
                      Test
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="slackWebhookUrl">Slack Webhook URL</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input 
                      type="password" 
                      id="slackWebhookUrl"
                      name="slackWebhookUrl" 
                      className="form-control"
                      placeholder={settings.masked.slackWebhookUrl || "Enter Slack Webhook URL"}
                      value={settingsForm.slackWebhookUrl}
                      onChange={handleSettingsChange}
                      style={{ flexGrow: 1 }}
                    />
                    <button type="button" className="btn btn-secondary" onClick={handleTestSlack} disabled={loading} style={{ padding: '0.5rem 0.75rem', fontSize: '0.8rem' }}>
                      Test
                    </button>
                  </div>
                </div>

                <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '1.5rem 0' }}>
                  <input 
                    type="checkbox" 
                    id="autoSync" 
                    name="autoSync"
                    style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                    checked={settingsForm.autoSync}
                    onChange={handleSettingsChange}
                  />
                  <label htmlFor="autoSync" style={{ margin: 0, cursor: 'pointer' }}>
                    Auto-sync configurations with GitHub on save
                  </label>
                </div>

                <div className="form-group" style={{ marginTop: '1rem' }}>
                  <label htmlFor="timezone">Scheduler Timezone</label>
                  <select 
                    id="timezone"
                    name="timezone" 
                    className="form-control"
                    value={settingsForm.timezone}
                    onChange={handleSettingsChange}
                  >
                    <option value="UTC">UTC</option>
                    <option value="Asia/Kolkata">Asia/Kolkata (IST - India)</option>
                    <option value="America/New_York">America/New_York (EST - New York)</option>
                    <option value="Europe/London">Europe/London (GMT - London)</option>
                    <option value="Asia/Singapore">Asia/Singapore (SGT - Singapore)</option>
                    <option value="America/Los_Angeles">America/Los_Angeles (PST - Pacific Time)</option>
                    <option value="Europe/Paris">Europe/Paris (CET - Paris)</option>
                    <option value="Asia/Tokyo">Asia/Tokyo (JST - Tokyo)</option>
                    <option value="Australia/Sydney">Australia/Sydney (AEDT - Sydney)</option>
                  </select>
                  <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
                    Your alerts and scheduling calculations will respect this timezone. (Auto-detected: <code>{Intl.DateTimeFormat().resolvedOptions().timeZone}</code>)
                  </small>
                </div>

                <div className="flex-gap-2">
                  <button type="submit" className="btn btn-primary" style={{ flexGrow: 1 }} disabled={loading}>
                    Save Settings
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={handleTestTelegram} disabled={loading}>
                    Test Telegram
                  </button>
                </div>
              </form>
            </div>

            {/* Setup Instructions Card */}
            <div className="glass-card">
              <h2 className="section-title">GitHub Serverless Setup Guide</h2>
              <ol className="instructions-list">
                <li>
                  <strong>Create a Private GitHub Repository:</strong>
                  <p className="mt-1">Go to GitHub and create a new **private** repository named <code>telegram-cron-alerts</code> (do not add a README or .gitignore).</p>
                </li>
                <li>
                  <strong>Initialize Git locally:</strong>
                  <p className="mt-1">Open a terminal in this project folder and run:</p>
                  <span className="code-block mt-1">
                    git init<br />
                    git branch -M main<br />
                    git remote add origin https://github.com/YOUR_USERNAME/telegram-cron-alerts.git
                  </span>
                </li>
                <li>
                  <strong>Add secrets to your repository:</strong>
                  <p className="mt-1">Go to your GitHub repo -&gt; Settings -&gt; Secrets and variables -&gt; Actions. Add these secrets:</p>
                  <ul style={{ paddingLeft: '1.25rem', marginTop: '0.25rem', fontSize: '0.85rem', lineHeight: '1.4' }}>
                    <li><code>TELEGRAM_BOT_TOKEN</code></li>
                    <li><code>TELEGRAM_CHAT_ID</code></li>
                    <li><code>GEMINI_API_KEY</code></li>
                    <li><code>DISCORD_WEBHOOK_URL</code> (optional)</li>
                    <li><code>SLACK_WEBHOOK_URL</code> (optional)</li>
                  </ul>
                </li>
                <li>
                  <strong>Enable Write Permissions for Workflows:</strong>
                  <p className="mt-1">Go to GitHub repo -&gt; Settings -&gt; Actions -&gt; General. Scroll down to **Workflow permissions**, select **"Read and write permissions"** and click **Save**.</p>
                </li>
                <li>
                  <strong>Commit and Push:</strong>
                  <p className="mt-1">Toggle <strong>"Auto-sync"</strong> in settings, save, and then click the <strong>"Sync GitHub"</strong> button at the top right to push configurations and activate the runner.</p>
                </li>
              </ol>
            </div>

            {/* Precision Scheduling Card */}
            <div className="glass-card mt-4">
              <h2 className="section-title">Precision Cloud Scheduling Setup</h2>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-dark)', marginBottom: '1rem' }}>
                GitHub's free cron scheduler is often delayed by 15-45 minutes. You can trigger your alerts at the exact scheduled second using a free cron service (like <strong>Cron-Job.org</strong>) hitting GitHub's Dispatch API.
              </p>
              
              <ol className="instructions-list">
                <li>
                  <strong>Create a GitHub PAT:</strong>
                  <p className="mt-1">
                    Create a <a href="https://github.com/settings/tokens/new?scopes=repo,workflow" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>Personal Access Token (Classic)</a> with both <strong><code>repo</code></strong> and <strong><code>workflow</code></strong> scopes selected (required for private repositories).
                  </p>
                </li>
                <li>
                  <strong>Create a Free Job on <a href="https://cron-job.org" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>Cron-Job.org</a>:</strong>
                  <p className="mt-1">Use these exact configurations:</p>
                  
                  <div style={{ background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: '4px', fontSize: '0.85rem', margin: '0.5rem 0' }}>
                    <div style={{ marginBottom: '0.5rem' }}>
                      <strong>Method:</strong> <code>POST</code>
                    </div>
                    
                    <div style={{ marginBottom: '0.5rem' }}>
                      <strong>URL:</strong>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                        <input 
                          type="text" 
                          readOnly 
                          className="form-control" 
                          value={settings.githubRepoPath ? `https://api.github.com/repos/${settings.githubRepoPath}/actions/workflows/scheduler.yml/dispatches` : 'https://api.github.com/repos/YOUR_USERNAME/YOUR_REPO/actions/workflows/scheduler.yml/dispatches'} 
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', flexGrow: 1 }} 
                          id="dispatch-url-input"
                        />
                        <button 
                          type="button" 
                          className={`btn ${copiedUrl ? 'btn-copied' : 'btn-secondary'}`}
                          onClick={() => handleCopy('dispatch-url-input', 'url')} 
                          style={{ padding: '0.25rem 0.75rem', fontSize: '0.75rem' }}
                        >
                          {copiedUrl ? '✓ Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>
                    
                    <div style={{ marginBottom: '0.5rem' }}>
                      <strong>Headers (Request Headers):</strong>
                      <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                        <li><code>Authorization: Bearer YOUR_GITHUB_PAT</code></li>
                        <li><code>Accept: application/vnd.github.v3+json</code></li>
                        <li><code>User-Agent: Cron-Job-Trigger</code></li>
                      </ul>
                    </div>
                    
                    <div>
                      <strong>Request Body (JSON):</strong>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                        <input 
                          type="text" 
                          readOnly 
                          className="form-control" 
                          value='{"ref": "main"}' 
                          style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', flexGrow: 1 }} 
                          id="dispatch-body-input"
                        />
                        <button 
                          type="button" 
                          className={`btn ${copiedBody ? 'btn-copied' : 'btn-secondary'}`}
                          onClick={() => handleCopy('dispatch-body-input', 'body')} 
                          style={{ padding: '0.25rem 0.75rem', fontSize: '0.75rem' }}
                        >
                          {copiedBody ? '✓ Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
                
                <li>
                  <strong>Verify / Test Setup:</strong>
                  <p className="mt-1">Paste your GitHub PAT below to verify immediately. If valid, it triggers your cloud Action run right now:</p>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                    <input 
                      type="password" 
                      className="form-control" 
                      placeholder="Paste your GitHub PAT" 
                      value={githubPat} 
                      onChange={(e) => setGithubPat(e.target.value)} 
                      style={{ flexGrow: 1 }}
                    />
                    <button 
                      type="button" 
                      className="btn btn-primary" 
                      onClick={handleTestDispatch} 
                      disabled={testingDispatch || !githubPat}
                      style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}
                    >
                      {testingDispatch ? 'Testing...' : 'Test Dispatch ⚡'}
                    </button>
                  </div>
                </li>
              </ol>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
