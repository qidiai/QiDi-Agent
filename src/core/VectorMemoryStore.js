/**
 * @module VectorMemoryStore
 *
 * 语义记忆存储 — 基于 embedding 向量的语义检索系统。
 *
 * 核心能力：
 * 1. 使用 Ollama embedding 模型 (nomic-embed-text) 对文本向量化
 * 2. 基于余弦相似度的语义检索
 * 3. 持久化存储到本地文件
 * 4. 支持按任务/工具/语言/标签多维度检索
 * 5. 与 MemoryStore 互补：精确匹配走 MemoryStore，语义匹配走 VectorMemoryStore
 *
 * 使用场景：
 * - "找到与当前任务最相似的历史执行"
 * - "查找类似代码问题的解决方案"
 * - "检索相关工具经验"
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const logger = require('../utils/Logger')('VectorMemoryStore');
const { safeJsonParse } = require('../utils/SafeParser');

class VectorMemoryStore {
  constructor (options = {}) {
    this.persistDir = options.persistDir || path.join(process.cwd(), 'data');
    this.persistFile = options.persistFile || 'vector_memory.json';
    this.persistPath = path.join(this.persistDir, this.persistFile);

    // Ollama embedding 配置
    this.ollamaUrl = options.ollamaUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.embeddingModel = options.embeddingModel || 'nomic-embed-text';
    this.embeddingDim = options.embeddingDim || 768;

    // 内存索引
    this.vectors = []; // [{ id, embedding, text, metadata, timestamp }]
    this._index = null; // 延迟构建

    // 配置
    this.maxItems = options.maxItems || 10000;
    this.similarityThreshold = options.similarityThreshold || 0.7;
    this.enableEmbeddingCache = true;
    this._embeddingCache = new Map();

    this._ensureDir(this.persistDir);
    this._load();
  }

  _ensureDir (dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // ── Embedding 生成 ──

  async generateEmbedding (text) {
    if (!text || text.trim().length === 0) return null;

    // 缓存检查
    if (this.enableEmbeddingCache) {
      const cacheKey = this._hashText(text);
      if (this._embeddingCache.has(cacheKey)) {
        return this._embeddingCache.get(cacheKey);
      }
    }

    try {
      const embedding = await this._callOllamaEmbed(text);
      if (embedding && this.enableEmbeddingCache) {
        const cacheKey = this._hashText(text);
        this._embeddingCache.set(cacheKey, embedding);
        // 限制缓存大小
        if (this._embeddingCache.size > 1000) {
          const firstKey = this._embeddingCache.keys().next().value;
          this._embeddingCache.delete(firstKey);
        }
      }
      return embedding;
    } catch (e) {
      logger.warn(`[VectorMemory] embedding 生成失败: ${e.message}`);
      // 降级：使用简单的 hash 向量
      return this._generateHashVector(text);
    }
  }

  _callOllamaEmbed (text) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ model: this.embeddingModel, input: text });
      const url = new URL('/api/embeddings', this.ollamaUrl);

      const options = {
        hostname: url.hostname,
        port: url.port || 11434,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 30000
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try {
            const data = safeJsonParse(body, {});
            if (data.embedding) resolve(data.embedding);
            else reject(new Error('无 embedding 返回'));
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama embedding 超时')); });
      req.write(postData);
      req.end();
    });
  }

  /**
   * 降级方案：基于文本 hash 的伪向量
   */
  _generateHashVector (text, dim = this.embeddingDim) {
    const vector = new Array(dim).fill(0);
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      const idx = Math.abs(hash) % dim;
      vector[idx] += 1;
    }
    // 归一化
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
    return vector.map(v => v / norm);
  }

  // ── 核心操作 ──

  /**
   * 存储一条记忆
   * @param {string} text - 文本内容
   * @param {Object} metadata - 元数据 { taskTitle, language, toolName, taskType, qualityScore, ... }
   * @returns {Promise<string>} 记忆ID
   */
  async store (text, metadata = {}) {
    const embedding = await this.generateEmbedding(text);
    if (!embedding) return null;

    const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const item = {
      id,
      embedding,
      text: text.substring(0, 5000), // 限制文本长度
      metadata: {
        ...metadata,
        timestamp: Date.now(),
        createdAt: new Date().toISOString()
      }
    };

    this.vectors.push(item);

    // 容量限制：FIFO 淘汰
    if (this.vectors.length > this.maxItems) {
      this.vectors.shift();
    }

    this._saveDebounced();
    logger.info(`[VectorMemory] 存储记忆: ${id}, metadata=${JSON.stringify(metadata).substring(0, 100)}`);
    return id;
  }

  /**
   * 语义搜索
   * @param {string} query - 查询文本
   * @param {Object} filters - 过滤条件 { language, toolName, taskType, minScore }
   * @param {number} topK - 返回前K个结果
   * @returns {Promise<Array>} 搜索结果
   */
  async search (query, filters = {}, topK = 5) {
    if (this.vectors.length === 0) return [];

    const queryEmbedding = await this.generateEmbedding(query);
    if (!queryEmbedding) return [];

    // 计算相似度
    const scores = this.vectors.map(item => {
      // 过滤
      if (filters.language && item.metadata.language !== filters.language) return null;
      if (filters.toolName && item.metadata.toolName !== filters.toolName) return null;
      if (filters.taskType && item.metadata.taskType !== filters.taskType) return null;

      const similarity = this._cosineSimilarity(queryEmbedding, item.embedding);
      return { item, score: similarity };
    }).filter(s => s !== null);

    // 排序
    scores.sort((a, b) => b.score - a.score);

    // 过滤阈值
    const minScore = filters.minScore || this.similarityThreshold;
    const results = scores
      .filter(s => s.score >= minScore)
      .slice(0, topK)
      .map(s => ({
        id: s.item.id,
        text: s.item.text,
        metadata: s.item.metadata,
        score: s.score
      }));

    return results;
  }

  /**
   * 获取相似任务的历史执行
   */
  async findSimilarTasks (taskDescription, topK = 3) {
    return this.search(taskDescription, {}, topK);
  }

  /**
   * 获取工具的相似经验
   */
  async findToolExperience (toolName, taskDescription, topK = 3) {
    return this.search(taskDescription, { toolName }, topK);
  }

  /**
   * 获取最佳实践（高评分历史）
   */
  async findBestPractices (query, topK = 5) {
    const results = await this.search(query, { minScore: 0.5 }, topK * 2);
    return results
      .filter(r => r.metadata.qualityScore && r.metadata.qualityScore >= 80)
      .slice(0, topK);
  }

  /**
   * 删除记忆
   */
  delete (id) {
    const idx = this.vectors.findIndex(v => v.id === id);
    if (idx !== -1) {
      this.vectors.splice(idx, 1);
      this._saveDebounced();
      return true;
    }
    return false;
  }

  /**
   * 清理过期记忆
   */
  cleanup (maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const before = this.vectors.length;
    this.vectors = this.vectors.filter(v => now - v.metadata.timestamp < maxAgeMs);
    const removed = before - this.vectors.length;
    if (removed > 0) {
      logger.info(`[VectorMemory] 清理过期记忆: ${removed}条`);
      this._saveDebounced();
    }
    return removed;
  }

  // ── 工具方法 ──

  _cosineSimilarity (a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  _hashText (text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return `h_${Math.abs(hash)}`;
  }

  // ── 持久化 ──

  _save () {
    try {
      const data = {
        version: 1,
        vectors: this.vectors.map(v => ({
          id: v.id,
          embedding: v.embedding,
          text: v.text,
          metadata: v.metadata
        })),
        savedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(data), 'utf-8');
    } catch (e) {
      logger.warn(`[VectorMemory] 保存失败: ${e.message}`);
    }
  }

  _saveTimer = null;

  _saveDebounced () {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 2000);
  }

  _load () {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = safeJsonParse(fs.readFileSync(this.persistPath, 'utf-8'), { vectors: [] });
        this.vectors = data.vectors || [];
        logger.info(`[VectorMemory] 已加载 ${this.vectors.length} 条记忆`);
      }
    } catch (e) {
      logger.warn(`[VectorMemory] 加载失败: ${e.message}`);
      this.vectors = [];
    }
  }

  /**
   * 获取统计信息
   */
  getStats () {
    const langCounts = {};
    const toolCounts = {};
    let totalQuality = 0;
    let qualityCount = 0;

    for (const v of this.vectors) {
      if (v.metadata.language) langCounts[v.metadata.language] = (langCounts[v.metadata.language] || 0) + 1;
      if (v.metadata.toolName) toolCounts[v.metadata.toolName] = (toolCounts[v.metadata.toolName] || 0) + 1;
      if (v.metadata.qualityScore) {
        totalQuality += v.metadata.qualityScore;
        qualityCount++;
      }
    }

    return {
      totalMemories: this.vectors.length,
      languages: langCounts,
      tools: toolCounts,
      avgQuality: qualityCount > 0 ? Math.round(totalQuality / qualityCount) : 0,
      cacheSize: this._embeddingCache.size
    };
  }

  /**
   * 检查 Ollama embedding 是否可用
   */
  async checkAvailability () {
    try {
      const embedding = await this._callOllamaEmbed('test');
      return embedding && embedding.length > 0;
    } catch (e) {
      return false;
    }
  }
}

module.exports = VectorMemoryStore;
