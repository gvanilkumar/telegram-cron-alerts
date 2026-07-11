/**
 * @fileoverview Git synchronization and branch commit helpers.
 */

const { exec } = require('child_process');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

/**
 * Execute a shell command inside the root directory.
 * @param {string} command 
 * @returns {Promise<string>}
 */
function runCmd(command) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: config.rootDir }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Sync configuration updates to GitHub with autostash and rebase.
 * @returns {Promise<{synced: boolean, message: string}>}
 */
async function gitSync() {
  // Read current settings dynamically to see if autoSync was updated in settings.json
  let autoSync = false;
  try {
    if (fs.existsSync(config.settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(config.settingsPath, 'utf8'));
      autoSync = !!settings.autoSync;
    }
  } catch (err) {
    logger.warn('Failed to read settings in gitSync fallback, sync aborted.');
  }

  if (!autoSync) {
    return { synced: false, message: 'Auto-sync is disabled' };
  }

  try {
    // Check if git repository is initialized
    await runCmd('git rev-parse --is-inside-work-tree');
  } catch (e) {
    return { synced: false, message: 'Not a git repository. Please initialize git.' };
  }

  try {
    // 1. Stage all config files (config, state, and logs)
    await runCmd('git add tasks.json settings.json state.json logs/history.json');
    
    // 2. Commit changes locally only if there are active staged changes
    const changes = await runCmd('git diff --cached --name-only');
    if (changes.trim()) {
      await runCmd('git commit -m "Local config and state update [skip ci]"');
    }

    // 3. Pull with rebase from remote counterpart. Auto-stash dirty working changes, pull, and pop stash.
    let stashed = false;
    try {
      const status = await runCmd('git status --porcelain');
      // Check if there are unstaged changes
      if (status.trim()) {
        await runCmd('git stash -u');
        stashed = true;
      }
      await runCmd('git -c core.editor=true pull --rebase -X ours origin HEAD');
    } finally {
      if (stashed) {
        try {
          await runCmd('git stash pop');
        } catch (stashErr) {
          logger.warn(`Stash pop warning: ${stashErr.message}`);
        }
      }
    }
    
    // 4. Push changes back
    await runCmd('git push origin HEAD');
    return { synced: true, message: 'Configurations successfully synced to GitHub.' };
  } catch (err) {
    logger.error('Git sync error', err);
    throw new Error(`Git sync failed: ${err.message}`);
  }
}

module.exports = {
  runCmd,
  gitSync
};
