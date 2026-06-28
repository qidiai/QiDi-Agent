const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class CacheStore {
  constructor(options = {}) {
    this.options = options;
    this.cache = new Map();
    this.maxSize = options.maxSize || 100;
    this.maxAge = options.maxAge || 3600000;
    this.persistDir = options.persistDir || './cache';
    this.persistFile = options.persistFile || 'response_cache.json';
    this.similarityThreshold = options.similarityThreshold || 0.8;
    this.stats = {
      hits: 0,
      misses: 0,
      savedTokens: 0
    };

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
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        for (const [key, value] of Object.entries(data)) {
          if (Date.now() - value.timestamp < this.maxAge) {
            this.cache.set(key, value);
          }
        }
      }
    } catch (e) {
    }
  }

  _save() {
    try {
      const filePath = path.join(this.persistDir, this.persistFile);
      const data = {};
      for (const [key, value] of this.cache.entries()) {
        data[key] = value;
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
    }
  }

  _hash(input) {
    const normalized = typeof input === 'string' ? input : JSON.stringify(input);
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  _normalizeText(text) {
    return text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '')
      .trim();
  }

  _calculateSimilarity(text1, text2) {
    const norm1 = this._normalizeText(text1);
    const norm2 = this._normalizeText(text2);
    
    const words1 = norm1.split(' ');
    const words2 = norm2.split(' ');
    
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
  }

  set(key, response, metadata = {}) {
    const cacheKey = this._hash(key);
    
    const entry = {
      key: cacheKey,
      originalKey: key.substring(0, 100),
      response: response,
      metadata: {
        ...metadata,
        timestamp: Date.now(),
        tokens: metadata.tokens || 0
      }
    };

    this.cache.set(cacheKey, entry);
    
    if (this.cache.size > this.maxSize) {
      this._evictOldest();
    }

    this._debouncedSave();
    return cacheKey;
  }

  get(key) {
    const cacheKey = this._hash(key);
    
    const entry = this.cache.get(cacheKey);
    
    if (entry) {
      if (Date.now() - entry.metadata.timestamp > this.maxAge) {
        this.cache.delete(cacheKey);
        this.stats.misses++;
        return null;
      }

      this.stats.hits++;
      this.stats.savedTokens += entry.metadata.tokens || 0;
      return {
        response: entry.response,
        metadata: entry.metadata,
        cached: true
      };
    }

    const similarResult = this._findSimilar(key);
    if (similarResult) {
      this.stats.hits++;
      this.stats.savedTokens += similarResult.metadata.tokens || 0;
      return {
        response: similarResult.response,
        metadata: similarResult.metadata,
        cached: true,
        similarity: similarResult.similarity
      };
    }

    this.stats.misses++;
    return null;
  }

  _findSimilar(key, threshold) {
    const thresholdVal = threshold != null ? threshold : this.similarityThreshold;
    const normalizedKey = this._normalizeText(key);
    let bestMatch = null;
    let bestSimilarity = 0;
    
    let iterations = 0;
    for (const [cacheKey, entry] of this.cache.entries()) {
      if (++iterations > 5000) break; // 防止大缓存时完全遍历
      if (!entry || !entry.originalKey) continue;
      const similarity = this._calculateSimilarity(key, entry.originalKey);
      
      if (similarity >= thresholdVal && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = {
          response: entry.response,
          metadata: entry.metadata,
          similarity: similarity
        };
      }
    }

    return bestMatch;
  }

  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.metadata.timestamp < oldestTime) {
        oldestTime = entry.metadata.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    const cacheKey = this._hash(key);
    const result = this.cache.delete(cacheKey);
    this._debouncedSave();
    return result;
  }

  clear() {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, savedTokens: 0 };
    this._debouncedSave();
  }

  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: this.stats.hits > 0 
        ? Math.round((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100)
        : 0
    };
  }

  getReport() {
    const stats = this.getStats();
    
    let report = `\n📊 缓存统计报告\n`;
    report += `═══════════════════════════════════════════\n`;
    report += `缓存大小: ${stats.size}/${stats.maxSize}\n`;
    report += `命中次数: ${stats.hits}\n`;
    report += `未命中次数: ${stats.misses}\n`;
    report += `命中率: ${stats.hitRate}%\n`;
    report += `节省 tokens: ${stats.savedTokens.toLocaleString()}\n`;
    report += `═══════════════════════════════════════════\n`;
    
    return report;
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

  /**
   * 强制立即持久化
   */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._pendingSave = false;
    this._save();
  }

  pruneExpired() {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.metadata.timestamp > this.maxAge) {
        this.cache.delete(key);
        pruned++;
      }
    }

    this._debouncedSave();
    return pruned;
  }

  /**
   * 查找与给定文本语义相似的缓存条目
   */
  findSimilar(text, threshold) {
    return this._findSimilar(text, threshold);
  }

  setTaskResponse(taskId, agentName, task, response, metadata = {}) {
    const desc = typeof task === 'object' && task ? (task.description || task.title || JSON.stringify(task).substring(0, 50)) : String(task || '').substring(0, 50);
    const title = typeof task === 'object' && task ? (task.title || task.description || '') : '';
    const key = `${agentName}:${taskId}:${String(title).substring(0, 50)}:${String(desc).substring(0, 50)}`;
    return this.set(key, response, {
      ...metadata,
      taskId,
      agentName
    });
  }

  getTaskResponse(taskId, agentName, task) {
    const desc = typeof task === 'object' && task ? (task.description || task.title || JSON.stringify(task).substring(0, 50)) : String(task || '').substring(0, 50);
    const title = typeof task === 'object' && task ? (task.title || task.description || '') : '';
    const key = `${agentName}:${taskId}:${String(title).substring(0, 50)}:${String(desc).substring(0, 50)}`;
    return this.get(key);
  }
}

module.exports = CacheStore;