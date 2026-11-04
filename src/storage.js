const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '../config');
const DATA_DIR = path.join(__dirname, '../data');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const MAPPINGS_FILE = path.join(CONFIG_DIR, 'mappings.json');
const LOGS_FILE = path.join(DATA_DIR, 'history.json');

// Garantir que as pastas existem
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), 'utf-8');
      return fallback;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`Erro ao ler ${filePath}:`, err);
    return fallback;
  }
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`Erro ao salvar ${filePath}:`, err);
    return false;
  }
}

class Storage {
  static getSettings() {
    return readJSON(SETTINGS_FILE, {});
  }

  static updateSettings(newSettings) {
    const current = this.getSettings();
    const merged = { ...current, ...newSettings };
    writeJSON(SETTINGS_FILE, merged);
    return merged;
  }

  static getMappings() {
    return readJSON(MAPPINGS_FILE, { rules: [] });
  }

  static updateMappings(mappings) {
    writeJSON(MAPPINGS_FILE, mappings);
    return mappings;
  }

  static addRule(rule) {
    const data = this.getMappings();
    const idx = data.rules.findIndex(r => r.id === rule.id);
    if (idx >= 0) {
      data.rules[idx] = { ...data.rules[idx], ...rule };
    } else {
      data.rules.push(rule);
    }
    writeJSON(MAPPINGS_FILE, data);
    return data;
  }

  static updateRule(ruleId, patch) {
    const data = this.getMappings();
    const idx = data.rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return null;
    data.rules[idx] = { ...data.rules[idx], ...patch };
    writeJSON(MAPPINGS_FILE, data);
    return { rule: data.rules[idx], mappings: data };
  }

  static deleteRule(ruleId) {
    const data = this.getMappings();
    data.rules = data.rules.filter(r => r.id !== ruleId);
    writeJSON(MAPPINGS_FILE, data);
    return data;
  }

  static getHistory(limit = 100) {
    const history = readJSON(LOGS_FILE, []);
    return history.slice(-limit).reverse();
  }

  static addHistoryEntry(entry) {
    const history = readJSON(LOGS_FILE, []);
    const record = {
      id: entry.id || Date.now().toString(),
      timestamp: new Date().toISOString(),
      ...entry
    };
    history.push(record);
    // Limitar histórico a 1000 registros para evitar arquivos gigantes
    if (history.length > 1000) {
      history.splice(0, history.length - 1000);
    }
    writeJSON(LOGS_FILE, history);
    return record;
  }

  static updateHistoryStatus(id, status, error = null) {
    const history = readJSON(LOGS_FILE, []);
    const item = history.find(h => h.id === id);
    if (item) {
      item.status = status;
      if (error) item.error = error;
      item.updatedAt = new Date().toISOString();
      writeJSON(LOGS_FILE, history);
    }
  }
}

module.exports = Storage;
