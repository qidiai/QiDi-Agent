const fs = require('fs');
const path = require('path');

class MemoryStore {
  constructor(options = {}) {
    this.store = {
      global: {},
      tasks: {},
      tags: {}
    };
    this.persistDir = options.persistDir || './memory';
    this.persistFile = options.persistFile || 'session.json';
    this.maxHistory = options.maxHistory || 100;
    
    this._ensureDir(this.persistDir);
    this._load();
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _load() {
    try {
      const filePath = path.join(this.persistDir, this.persistFile);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        this.store = JSON.parse(data);
      }
    } catch (e) {
      this.store = { global: {}, tasks: {}, tags: {} };
    }
  }

  _save() {
    try {
      const filePath = path.join(this.persistDir, this.persistFile);
      fs.writeFileSync(filePath, JSON.stringify(this.store, null, 2));
    } catch (e) {
    }
  }

  setGlobal(key, value) {
    this.store.global[key] = value;
    this._save();
    return this;
  }

  getGlobal(key, defaultValue = null) {
    return this.store.global[key] !== undefined ? this.store.global[key] : defaultValue;
  }

  getAllGlobals() {
    return { ...this.store.global };
  }

  put(taskId, key, value) {
    if (!this.store.tasks[taskId]) {
      this.store.tasks[taskId] = {};
    }
    this.store.tasks[taskId][key] = value;
    this._save();
    return this;
  }

  get(taskId, key, defaultValue = null) {
    return this.store.tasks[taskId]?.[key] !== undefined 
      ? this.store.tasks[taskId][key] 
      : defaultValue;
  }

  getAll(taskId) {
    return this.store.tasks[taskId] || {};
  }

  append(taskId, key, value) {
    if (!this.store.tasks[taskId]) {
      this.store.tasks[taskId] = {};
    }
    if (!Array.isArray(this.store.tasks[taskId][key])) {
      this.store.tasks[taskId][key] = [];
    }
    this.store.tasks[taskId][key].push(value);
    this._save();
    return this;
  }

  queryByTag(tag) {
    const results = [];
    for (const [taskId, taskData] of Object.entries(this.store.tasks)) {
      if (taskData.tags && taskData.tags.includes(tag)) {
        results.push({ taskId, ...taskData });
      }
    }
    return results;
  }

  addTag(taskId, tag) {
    if (!this.store.tasks[taskId]) {
      this.store.tasks[taskId] = {};
    }
    if (!this.store.tasks[taskId].tags) {
      this.store.tasks[taskId].tags = [];
    }
    if (!this.store.tasks[taskId].tags.includes(tag)) {
      this.store.tasks[taskId].tags.push(tag);
    }
    this._save();
    return this;
  }

  getTaskHistory(taskIds) {
    const history = [];
    for (const taskId of taskIds) {
      const taskData = this.store.tasks[taskId];
      if (taskData) {
        history.push({
          taskId,
          content: taskData.content,
          codeBlocks: taskData.codeBlocks,
          qualityScore: taskData.qualityScore,
          status: taskData.status
        });
      }
    }
    return history;
  }

  getFullContext(taskId) {
    const taskData = this.store.tasks[taskId] || {};
    return {
      global: this.getAllGlobals(),
      task: taskData,
      history: this.getTaskHistory(Object.keys(this.store.tasks).filter(id => id !== taskId))
    };
  }

  clear() {
    this.store = { global: {}, tasks: {}, tags: {} };
    this._save();
    return this;
  }

  clearTask(taskId) {
    delete this.store.tasks[taskId];
    this._save();
    return this;
  }
}

module.exports = MemoryStore;
