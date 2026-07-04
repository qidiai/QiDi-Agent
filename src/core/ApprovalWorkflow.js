/**
 * @module ApprovalWorkflow
 *
 * 人工审批工作流管理器。
 *
 * 核心能力：
 * 1. 关键节点暂停等待人工审批
 * 2. 审批超时自动处理
 * 3. 审批历史记录
 * 4. 多种审批策略
 * 5. WebUI 审批接口集成
 *
 * 审批节点：
 * - pre_execute: 任务执行前
 * - post_split: 任务拆分后
 * - post_quality: 质检后
 * - pre_merge: 合并前
 * - post_merge: 合并后
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/Logger')('ApprovalWorkflow');
const { safeJsonParse } = require('../utils/SafeParser');

class ApprovalWorkflow extends EventEmitter {
  constructor (options = {}) {
    super();
    this.enabled = options.enabled !== false;
    this.timeout = options.timeout || 300000; // 5分钟默认超时
    this.autoApproveOnTimeout = options.autoApproveOnTimeout || false;
    this.persistPath = options.persistPath || path.join(process.cwd(), 'data', 'approval_history.json');

    // 审批节点配置
    this.checkpoints = options.checkpoints || {
      pre_execute: { enabled: false, description: '任务执行前审批' },
      post_split: { enabled: false, description: '任务拆分后审批' },
      post_quality: { enabled: true, description: '质检后审批（低分时触发）', minScore: 60 },
      pre_merge: { enabled: false, description: '合并前审批' },
      post_merge: { enabled: false, description: '合并后审批' }
    };

    // 待审批请求
    this._pending = new Map();
    // 审批历史
    this._history = [];

    this._loadHistory();
  }

  /**
   * 请求审批
   */
  async requestApproval (checkpoint, context = {}) {
    if (!this.enabled) return { approved: true, auto: true };
    if (!this.checkpoints[checkpoint]?.enabled) return { approved: true, auto: true };

    // 检查是否满足触发条件
    if (checkpoint === 'post_quality') {
      const minScore = this.checkpoints[checkpoint].minScore || 60;
      if (context.qualityScore && context.qualityScore >= minScore) {
        return { approved: true, auto: true, reason: '质量分数达标，自动通过' };
      }
    }

    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const request = {
      id: approvalId,
      checkpoint,
      description: this.checkpoints[checkpoint]?.description || checkpoint,
      context,
      status: 'pending',
      timestamp: Date.now(),
      timeout: this.timeout
    };

    this._pending.set(approvalId, request);
    this.emit('approvalRequested', request);
    logger.info(`[ApprovalWorkflow] 审批请求: ${approvalId} (${checkpoint})`);

    // 等待审批
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pending.has(approvalId)) {
          if (this.autoApproveOnTimeout) {
            this._approve(approvalId, 'auto_timeout', '审批超时自动通过');
            resolve({ approved: true, auto: true, reason: '审批超时自动通过', id: approvalId });
          } else {
            this._reject(approvalId, 'auto_timeout', '审批超时自动拒绝');
            resolve({ approved: false, auto: true, reason: '审批超时自动拒绝', id: approvalId });
          }
        }
      }, this.timeout);

      const onApproved = (id, approver, comment) => {
        if (id === approvalId) {
          clearTimeout(timer);
          this.removeListener('approved', onApproved);
          this.removeListener('rejected', onRejected);
          resolve({ approved: true, auto: false, approver, comment, id: approvalId });
        }
      };

      const onRejected = (id, approver, comment) => {
        if (id === approvalId) {
          clearTimeout(timer);
          this.removeListener('approved', onApproved);
          this.removeListener('rejected', onRejected);
          resolve({ approved: false, auto: false, approver, comment, id: approvalId });
        }
      };

      this.on('approved', onApproved);
      this.on('rejected', onRejected);
    });
  }

  /**
   * 批准审批
   */
  approve (approvalId, approver = 'user', comment = '') {
    return this._approve(approvalId, approver, comment);
  }

  /**
   * 拒绝审批
   */
  reject (approvalId, approver = 'user', comment = '') {
    return this._reject(approvalId, approver, comment);
  }

  _approve (approvalId, approver, comment) {
    const request = this._pending.get(approvalId);
    if (!request) return false;

    request.status = 'approved';
    request.approver = approver;
    request.comment = comment;
    request.resolvedAt = Date.now();

    this._history.push(request);
    this._pending.delete(approvalId);
    this._saveHistory();

    this.emit('approved', approvalId, approver, comment);
    logger.info(`[ApprovalWorkflow] 审批通过: ${approvalId} by ${approver}`);
    return true;
  }

  _reject (approvalId, approver, comment) {
    const request = this._pending.get(approvalId);
    if (!request) return false;

    request.status = 'rejected';
    request.approver = approver;
    request.comment = comment;
    request.resolvedAt = Date.now();

    this._history.push(request);
    this._pending.delete(approvalId);
    this._saveHistory();

    this.emit('rejected', approvalId, approver, comment);
    logger.info(`[ApprovalWorkflow] 审批拒绝: ${approvalId} by ${approver}`);
    return true;
  }

  /**
   * 获取待审批列表
   */
  getPendingApprovals () {
    return Array.from(this._pending.values());
  }

  /**
   * 获取审批历史
   */
  getHistory (limit = 50) {
    return this._history.slice(-limit);
  }

  /**
   * 配置审批节点
   */
  configureCheckpoint (checkpoint, config) {
    if (!this.checkpoints[checkpoint]) {
      this.checkpoints[checkpoint] = { enabled: false, description: checkpoint };
    }
    Object.assign(this.checkpoints[checkpoint], config);
  }

  /**
   * 获取审批统计
   */
  getStats () {
    const total = this._history.length;
    const approved = this._history.filter(h => h.status === 'approved').length;
    const rejected = this._history.filter(h => h.status === 'rejected').length;
    const pending = this._pending.size;

    return {
      total,
      approved,
      rejected,
      pending,
      approvalRate: total > 0 ? ((approved / total) * 100).toFixed(1) + '%' : '0%'
    };
  }

  _saveHistory () {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify({
        history: this._history.slice(-200),
        savedAt: new Date().toISOString()
      }, null, 2), 'utf-8');
    } catch (e) {
      logger.warn(`[ApprovalWorkflow] 保存失败: ${e.message}`);
    }
  }

  _loadHistory () {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = safeJsonParse(fs.readFileSync(this.persistPath, 'utf-8'), {});
        this._history = data.history || [];
      }
    } catch (e) {
      logger.warn(`[ApprovalWorkflow] 加载失败: ${e.message}`);
    }
  }
}

module.exports = ApprovalWorkflow;
