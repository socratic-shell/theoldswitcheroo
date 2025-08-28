import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Common constants
export const LOCAL_DATA_DIR = path.join(os.homedir(), '.socratic-shell', 'theoldswitcheroo');
export const TASKSPACES_FILE = path.join(LOCAL_DATA_DIR, 'taskspaces.json');
export const SETTINGS_FILE = path.join(LOCAL_DATA_DIR, 'settings.json');
export const BASE_DIR = "~/.socratic-shell/theoldswitcheroo";

export interface Settings {
  hostname?: string;
}

// Load settings from file
export function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (error) {
    console.log(`Warning: Could not load settings: ${error.message}`);
  }
  return {};
}

// Save settings to file
export function saveSettings(settings: Settings): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.log(`Warning: Could not save settings: ${error.message}`);
  }
}
