const logger = require('../utils/Logger')('SynchronyMeter');
const fs = require('fs');
const path = require('path');

class SynchronyMeter {
  constructor (options = {}) {
    this.alpha = options.alpha || 0.4;
    this.beta = options.beta || 0.4;
    this.gamma = options.gamma || 0.2;
    this.history = options.history || [];
    this._historyPath = path.join(__dirname, '..', '..', 'data', 'synchrony_history.json');
    this._loadHistory();
  }

  async measure (results) {
    try {
      const F = this._functionalSync(results);
      const G = this._structuralSync(results);
      const M = this._molecularSync(results);
      const S = this.alpha * F + this.beta * G + this.gamma * M;
      const threshold = 0.7;
      const emerged = S > threshold;

      const record = {
        timestamp: Date.now(),
        S,
        F,
        G,
        M,
        toolCount: results.size,
        emerged
      };
      this.history.push(record);
      await this._saveHistory();

      return { F, G, M, S, threshold, emerged };
    } catch (e) {
      logger.warn(`[SynchronyMeter] 度量失败: ${e.message}`);
      return { F: 0.5, G: 0.5, M: 0.5, S: 0.5, threshold: 0.7, emerged: false };
    }
  }

  _functionalSync (results) {
    try {
      const signaturesList = [];
      for (const [, result] of results) {
        const code = result.code || result.output || '';
        const signatures = new Set(code.match(/function\s+\w+|def\s+\w+|class\s+\w+/g) || []);
        signaturesList.push(signatures);
      }

      if (signaturesList.length < 2) return 0.5;

      let totalSimilarity = 0;
      let count = 0;
      for (let i = 0; i < signaturesList.length; i++) {
        for (let j = i + 1; j < signaturesList.length; j++) {
          totalSimilarity += this._jaccard(signaturesList[i], signaturesList[j]);
          count++;
        }
      }
      return count > 0 ? totalSimilarity / count : 0.5;
    } catch (e) {
      logger.warn(`[SynchronyMeter] 功能同步度量失败: ${e.message}`);
      return 0.5;
    }
  }

  _structuralSync (results) {
    try {
      const filesList = [];
      for (const [, result] of results) {
        const files = result.files || [];
        const fileSet = new Set(files.map(f => typeof f === 'string' ? f : (f.path || f.name || '')));
        filesList.push(fileSet);
      }

      if (filesList.length < 2) return 0.5;

      let totalSimilarity = 0;
      let count = 0;
      for (let i = 0; i < filesList.length; i++) {
        for (let j = i + 1; j < filesList.length; j++) {
          totalSimilarity += this._jaccard(filesList[i], filesList[j]);
          count++;
        }
      }
      return count > 0 ? totalSimilarity / count : 0.5;
    } catch (e) {
      logger.warn(`[SynchronyMeter] 结构同步度量失败: ${e.message}`);
      return 0.5;
    }
  }

  _molecularSync (results) {
    try {
      const paramsList = [];
      for (const [, result] of results) {
        paramsList.push({
          model: result.model || 'unknown',
          temperature: result.temperature || 0.7
        });
      }

      if (paramsList.length < 2) return 0.5;

      let modelMatchCount = 0;
      let tempDiffSum = 0;
      let count = 0;
      for (let i = 0; i < paramsList.length; i++) {
        for (let j = i + 1; j < paramsList.length; j++) {
          if (paramsList[i].model === paramsList[j].model) modelMatchCount++;
          tempDiffSum += Math.abs(paramsList[i].temperature - paramsList[j].temperature);
          count++;
        }
      }

      if (count === 0) return 0.5;
      const modelMatchAvg = modelMatchCount / count;
      const tempDiffAvg = tempDiffSum / count;
      const M = 0.6 * modelMatchAvg + 0.4 * (1 - tempDiffAvg);
      return Math.max(0, Math.min(1, M));
    } catch (e) {
      logger.warn(`[SynchronyMeter] 分子同步度量失败: ${e.message}`);
      return 0.5;
    }
  }

  _jaccard (setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    const intersection = [...setA].filter(x => setB.has(x)).length;
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  getHistory (n = 20) {
    return this.history.slice(-n);
  }

  getAverageSync (n = 10) {
    const recent = this.history.slice(-n);
    if (recent.length === 0) return 0.5;
    const sum = recent.reduce((acc, r) => acc + r.S, 0);
    return sum / recent.length;
  }

  reset () {
    this.history = [];
    this._saveHistory();
  }

  _loadHistory () {
    try {
      if (fs.existsSync(this._historyPath)) {
        const data = fs.readFileSync(this._historyPath, 'utf8');
        this.history = JSON.parse(data);
      }
    } catch (e) {
      logger.warn(`[SynchronyMeter] 加载历史失败: ${e.message}`);
      this.history = [];
    }
  }

  async _saveHistory () {
    try {
      const dir = path.dirname(this._historyPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._historyPath, JSON.stringify(this.history, null, 2));
    } catch (e) {
      logger.warn(`[SynchronyMeter] 保存历史失败: ${e.message}`);
    }
  }
}

module.exports = SynchronyMeter;
