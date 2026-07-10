import React, { useState, useEffect } from 'react';

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
    schedule: '5m'
  });

  // Settings credentials form state
  const [settingsForm, setSettingsForm] = useState({
    telegramBotToken: '',
    telegramChatId: '',
    geminiApiKey: '',
    autoSync: false
  });

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
        autoSync: data.autoSync
      });
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Task Handlers
  const handleTaskFormChange = (e) => {
    const { name, value } = e.target;
    setTaskForm(prev => ({ ...prev, [name]: value }));
  };

  const startEditTask = (task) => {
    setEditingTask(task);
    setTaskForm({
      name: task.name,
      type: task.type,
      prompt: task.prompt,
      schedule: task.schedule
    });
  };

  const cancelEditTask = () => {
    setEditingTask(null);
    setTaskForm({ name: '', type: 'ai', prompt: '', schedule: '5m' });
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
      showToast('Alert sent successfully to Telegram!');
      fetchLogs();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
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
          <div className="logo-icon">🔔</div>
          <div className="logo-text">
            <h1>Telegram Alerts</h1>
            <p>GitHub Actions Serverless Scheduler</p>
          </div>
        </div>

        <div className="server-control">
          <button 
            className="btn btn-secondary flex-gap-1" 
            onClick={handleGitSync} 
            disabled={gitLoading}
          >
            <span>{gitLoading ? '⚙' : '🔄'}</span>
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
            <div className="dashboard-grid">
              <div className="glass-card stat-card">
                <div className="stat-info">
                  <h3>Active Alert Tasks</h3>
                  <div className="stat-number">{tasks.filter(t => t.active).length} / {tasks.length}</div>
                </div>
                <div className="stat-icon purple">⏰</div>
              </div>
              
              <div className="glass-card stat-card">
                <div className="stat-info">
                  <h3>Alerts Executed</h3>
                  <div className="stat-number">
                    {logs.filter(l => l.status === 'success').length}
                  </div>
                </div>
                <div className="stat-icon cyan">🚀</div>
              </div>

              <div className="glass-card stat-card">
                <div className="stat-info">
                  <h3>Sync State</h3>
                  <div className="stat-number" style={{ fontSize: '1.25rem', marginTop: '0.5rem' }}>
                    {settings.autoSync ? 'Auto Git Sync: On' : 'Auto Git Sync: Off'}
                  </div>
                </div>
                <div className="stat-icon success">🛡</div>
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
                        <div className="flex-gap-1 mt-1">
                          <span className="task-schedule-tag">{getScheduleLabel(task.schedule)}</span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-dark)' }}>
                            [{task.type.toUpperCase()}]
                          </span>
                        </div>
                      </div>
                      
                      <div className="task-actions">
                        <button 
                          className="btn btn-secondary btn-icon" 
                          title="Run Now (Telegram test)"
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
                      value={taskForm.schedule}
                      onChange={handleTaskFormChange}
                    >
                      <option value="5m">Every 5 Minutes</option>
                      <option value="15m">Every 15 Minutes</option>
                      <option value="1h">Every Hour</option>
                      <option value="5h">Every 5 Hours</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="task-prompt">
                    {taskForm.type === 'ai' 
                      ? 'AI Prompt Instructions (What should Gemini write?)' 
                      : 'Static Message Content (Text to send directly)'}
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
                </div>

                <div className="flex-gap-2 mt-4">
                  <button type="submit" className="btn btn-primary" disabled={loading} style={{ flexGrow: 1 }}>
                    {editingTask ? 'Update Task' : 'Create Task'}
                  </button>
                  {editingTask && (
                    <button type="button" className="btn btn-secondary" onClick={cancelEditTask}>
                      Cancel
                    </button>
                  )}
                </div>
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
                    {logs.map((log, index) => (
                      <tr key={index}>
                        <td>{new Date(log.timestamp).toLocaleString()}</td>
                        <td><strong>{log.taskName}</strong></td>
                        <td><span className="task-schedule-tag">{getScheduleLabel(log.schedule)}</span></td>
                        <td>
                          <span className={log.status === 'success' ? 'status-success' : 'status-error'}>
                            {log.status.toUpperCase()}
                          </span>
                        </td>
                        <td title={log.output}>{log.output}</td>
                      </tr>
                    ))}
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
                  <label htmlFor="geminiApiKey">Gemini API Key</label>
                  <input 
                    type="password" 
                    id="geminiApiKey"
                    name="geminiApiKey" 
                    className="form-control"
                    placeholder={settings.masked.geminiApiKey || "Enter Google Gemini API Key"}
                    value={settingsForm.geminiApiKey}
                    onChange={handleSettingsChange}
                  />
                  <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-dark)' }}>
                    Used for AI-generated alert text. Get one from Google AI Studio.
                  </small>
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

                <div className="flex-gap-2">
                  <button type="submit" className="btn btn-primary" style={{ flexGrow: 1 }} disabled={loading}>
                    Save Settings
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={handleTestTelegram} disabled={loading}>
                    Test Telegram Connection
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
                  <ul style={{ paddingLeft: '1.25rem', marginTop: '0.25rem', fontSize: '0.85rem' }}>
                    <li><code>TELEGRAM_BOT_TOKEN</code></li>
                    <li><code>TELEGRAM_CHAT_ID</code></li>
                    <li><code>GEMINI_API_KEY</code></li>
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
          </div>
        )}
      </main>
    </div>
  );
}
