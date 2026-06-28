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
    
    // 标签反向索引: tag -> Set<taskId>
    this._tagIndex = new Map();
    
    this._ensureDir(this.persistDir);
    this._load();
    this._saveTimer = null;
    this._pendingSave = false;
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
        this._rebuildTagIndex();
      }
    } catch (e) {
      this.store = { global: {}, tasks: {}, tags: {} };
    }
  }

  /**
   * 重建标签索引
   */
  _rebuildTagIndex() {
    this._tagIndex.clear();
    for (const [taskId, taskData] of Object.entries(this.store.tasks)) {
      if (taskData.tags && Array.isArray(taskData.tags)) {
        for (const tag of taskData.tags) {
          if (!this._tagIndex.has(tag)) {
            this._tagIndex.set(tag, new Set());
          }
          this._tagIndex.get(tag).add(taskId);
        }
      }
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
    this._debouncedSave();
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
    this._debouncedSave();
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
    this._debouncedSave();
    return this;
  }

  queryByTag(tag) {
    const taskIds = this._tagIndex.get(tag);
    if (!taskIds) return [];
    
    const results = [];
    for (const taskId of taskIds) {
      const taskData = this.store.tasks[taskId];
      if (taskData) {
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
      // 更新索引
      if (!this._tagIndex.has(tag)) {
        this._tagIndex.set(tag, new Set());
      }
      this._tagIndex.get(tag).add(taskId);
    }
    this._debouncedSave();
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
    this._tagIndex.clear();
    this._debouncedSave();
    return this;
  }

  clearTask(taskId) {
    if (this.store.tasks[taskId]) {
      // 从索引中移除该 task 的所有标签
      const taskData = this.store.tasks[taskId];
      if (taskData.tags) {
        for (const tag of taskData.tags) {
          const idx = this._tagIndex.get(tag);
          if (idx) {
            idx.delete(taskId);
            if (idx.size === 0) this._tagIndex.delete(tag);
          }
        }
      }
      delete this.store.tasks[taskId];
    }
    this._debouncedSave();
    return this;
  }

  _debouncedSave() {
    if (this._pendingSave) return;
    this._pendingSave = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._pendingSave = false;
      this._saveTimer = null;
      this._save();
    }, 1000);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._pendingSave = false;
    this._save();
  }
}

module.exports = MemoryStore;
