/**
 * 版本管理模块
 * 
 * 负责：
 * 1. 版本信息管理
 * 2. 更新检查
 * 3. 版本历史记录
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const logger = require('./Logger')('VersionManager');

class VersionManager {
  constructor(options = {}) {
    this.packagePath = options.packagePath || path.join(__dirname, '../../package.json');
    this.cacheDir = options.cacheDir || path.join(__dirname, '../../.cache');
    this.currentVersion = this._loadVersion();
    this.updateCheckInterval = options.updateCheckInterval || 24 * 60 * 60 * 1000; // 24小时
    this.lastCheckTime = null;
  }

  /**
   * 加载当前版本
   */
  _loadVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(this.packagePath, 'utf8'));
      return {
        version: pkg.version || '1.0.0',
        name: pkg.name || 'qidi-agent',
        description: pkg.description || ''
      };
    } catch (e) {
      return { version: '1.0.0', name: 'qidi-agent', description: '' };
    }
  }

  /**
   * 获取版本信息
   */
  getVersion() {
    return { ...this.currentVersion };
  }

  /**
   * 检查更新
   */
  async checkForUpdates(remoteUrl = 'https://api.github.com/repos/qidiai/QiDi-Agent/releases/latest') {
    try {
      this.lastCheckTime = Date.now();
      
      // 尝试获取远程版本
      const remoteVersion = await this._fetchRemoteVersion(remoteUrl);
      
      if (!remoteVersion) {
        return {
          hasUpdate: false,
          message: '无法检查更新，请稍后重试',
          currentVersion: this.currentVersion.version
        };
      }

      const hasUpdate = this._compareVersions(remoteVersion, this.currentVersion.version) > 0;

      return {
        hasUpdate,
        currentVersion: this.currentVersion.version,
        latestVersion: remoteVersion,
        message: hasUpdate 
          ? `发现新版本 ${remoteVersion}，当前版本 ${this.currentVersion.version}`
          : '已是最新版本',
        downloadUrl: hasUpdate ? `https://github.com/qidiai/QiDi-Agent/releases/tag/${remoteVersion}` : null
      };
    } catch (e) {
      return {
        hasUpdate: false,
        message: `检查更新失败: ${e.message}`,
        currentVersion: this.currentVersion.version
      };
    }
  }

  /**
   * 获取远程版本
   */
  _fetchRemoteVersion(url) {
    return new Promise((resolve) => {
      try {
        https.get(url, {
          headers: { 'User-Agent': 'qidi-agent' }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              // 支持 GitHub releases 格式
              const version = json.tag_name?.replace(/^v/, '') || json.version;
              resolve(version);
            } catch {
              resolve(null);
            }
          });
        }).on('error', () => resolve(null));
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * 比较版本号
   * 返回: 1 (v1 > v2), -1 (v1 < v2), 0 (v1 == v2)
   */
  _compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    
    return 0;
  }

  /**
   * 获取更新日志
   */
  async getChangelog(remoteUrl = 'https://raw.githubusercontent.com/qidiai/QiDi-Agent/main/CHANGELOG.md') {
    try {
      const changelog = await this._fetchRemoteContent(remoteUrl);
      return changelog || '无法获取更新日志';
    } catch (e) {
      return `获取更新日志失败: ${e.message}`;
    }
  }

  /**
   * 获取远程内容
   */
  _fetchRemoteContent(url) {
    return new Promise((resolve) => {
      try {
        https.get(url, {
          headers: { 'User-Agent': 'qidi-agent' }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', () => resolve(null));
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * 记录版本使用历史
   */
  recordUsage() {
    try {
      const historyFile = path.join(this.cacheDir, 'version_history.json');
      let history = [];
      
      if (fs.existsSync(historyFile)) {
        try {
          history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        } catch {
          history = [];
        }
      }

      history.push({
        version: this.currentVersion.version,
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        platform: process.platform
      });

      // 只保留最近 100 条记录
      if (history.length > 100) {
        history = history.slice(-100);
      }

      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      
      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
    } catch (e) {
      logger.warn('记录版本历史失败:', e.message);
    }
  }

  /**
   * 获取使用历史
   */
  getUsageHistory() {
    try {
      const historyFile = path.join(this.cacheDir, 'version_history.json');
      if (fs.existsSync(historyFile)) {
        return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      }
    } catch {
      // ignore
    }
    return [];
  }

  /**
   * 打印版本信息
   */
  printVersion() {
    console.log(`
╔═══════════════════════════════════════════════════╗
║           Qidi Agent 版本信息                      ║
╠═══════════════════════════════════════════════════╣
║  当前版本: ${this.currentVersion.version.padEnd(40)}║
║  项目名称: ${this.currentVersion.name.padEnd(40)}║
╚═══════════════════════════════════════════════════╝
    `);
  }

  /**
   * 打印更新信息
   */
  async printUpdateInfo() {
    const updateInfo = await this.checkForUpdates();
    
    console.log(`
╔═══════════════════════════════════════════════════╗
║           Qidi Agent 更新检查                     ║
╠═══════════════════════════════════════════════════╣
║  当前版本: ${updateInfo.currentVersion.padEnd(40)}║
║  最新版本: ${(updateInfo.latestVersion || '未知').padEnd(40)}║
║  状态: ${updateInfo.hasUpdate ? '🎉 有可用更新' : '✅ 已是最新版本'.padEnd(40)}║
╚═══════════════════════════════════════════════════╝
    `);
    
    if (updateInfo.hasUpdate && updateInfo.downloadUrl) {
      console.log(`\n📥 下载地址: ${updateInfo.downloadUrl}\n`);
    }
    
    return updateInfo;
  }
}

// 导出单例
const versionManager = new VersionManager();

module.exports = {
  VersionManager,
  versionManager,
  getVersion: () => versionManager.getVersion(),
  checkForUpdates: () => versionManager.checkForUpdates(),
  recordUsage: () => versionManager.recordUsage()
};