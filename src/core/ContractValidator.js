/**
 * @module ContractValidator
 *
 * 运行时契约验证器 — 在任务执行前后验证输入输出契约。
 *
 * 核心能力：
 * 1. 验证任务输入（约束、依赖、前置条件）
 * 2. 验证任务输出（代码块、文件结构、语言匹配）
 * 3. 验证 Agent 间传递的数据结构
 * 4. 验证适配器输出格式
 * 5. 违约报告与修复建议
 *
 * 契约类型：
 * - input: 输入契约（任务描述、约束、上下文）
 * - output: 输出契约（代码块、文件、测试结果）
 * - interface: 接口契约（Agent间数据传递）
 * - adapter: 适配器契约（工具执行结果格式）
 */

const logger = require('../utils/Logger')('ContractValidator');

class ContractValidator {
  constructor (options = {}) {
    this.strictMode = options.strictMode || false;
    this.autoFix = options.autoFix !== false;
    this.violationHistory = [];
    this._maxHistory = 200;
  }

  // ═══════════════════════════════════════════
  // 输入契约验证
  // ═══════════════════════════════════════════

  validateInput (task, context = {}) {
    const violations = [];

    // 1. 任务必须有标题和描述
    if (!task.title || task.title.trim().length === 0) {
      violations.push({ type: 'input', severity: 'critical', field: 'title', message: '任务标题缺失' });
    }
    if (!task.description || task.description.trim().length === 0) {
      violations.push({ type: 'input', severity: 'critical', field: 'description', message: '任务描述缺失' });
    }

    // 2. 语言约束检查
    if (context.constraints?.language) {
      const validLanguages = ['c', 'cpp', 'c++', 'python', 'javascript', 'typescript', 'go', 'java', 'rust', 'bash', 'shell'];
      if (!validLanguages.includes(context.constraints.language.toLowerCase())) {
        violations.push({ type: 'input', severity: 'high', field: 'constraints.language', message: `不支持的语言: ${context.constraints.language}` });
      }
    }

    // 3. 依赖任务检查
    if (task.dependencies && Array.isArray(task.dependencies)) {
      for (const dep of task.dependencies) {
        if (typeof dep !== 'string' && typeof dep !== 'number') {
          violations.push({ type: 'input', severity: 'medium', field: 'dependencies', message: `无效的依赖项: ${JSON.stringify(dep)}` });
        }
      }
    }

    // 4. 验收标准检查
    if (task.acceptanceCriteria) {
      const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [task.acceptanceCriteria];
      if (criteria.length === 0) {
        violations.push({ type: 'input', severity: 'low', field: 'acceptanceCriteria', message: '验收标准为空数组' });
      }
    }

    return this._buildResult(violations, 'input');
  }

  // ═══════════════════════════════════════════
  // 输出契约验证
  // ═══════════════════════════════════════════

  validateOutput (output, expectedContract = {}) {
    const violations = [];

    // 1. 代码块验证
    if (expectedContract.expectCode !== false) {
      if (!output.codeBlocks || output.codeBlocks.length === 0) {
        violations.push({ type: 'output', severity: 'high', field: 'codeBlocks', message: '未生成任何代码块' });
      } else {
        for (const block of output.codeBlocks) {
          if (!block.code || block.code.trim().length === 0) {
            violations.push({ type: 'output', severity: 'high', field: 'codeBlocks', message: `代码块 ${block.filePath || 'unknown'} 内容为空` });
          }
          if (!block.filePath) {
            violations.push({ type: 'output', severity: 'medium', field: 'codeBlocks', message: '代码块缺少文件路径' });
          }
          if (!block.language) {
            violations.push({ type: 'output', severity: 'low', field: 'codeBlocks', message: `代码块 ${block.filePath} 缺少语言标注` });
          }
        }
      }
    }

    // 2. 语言匹配验证
    if (expectedContract.language && output.codeBlocks) {
      const expectedLang = expectedContract.language.toLowerCase();
      for (const block of output.codeBlocks) {
        if (block.language && block.language.toLowerCase() !== expectedLang) {
          // 允许一些等价语言
          const equivalents = {
            'c++': ['cpp', 'c'],
            cpp: ['c++', 'c'],
            javascript: ['js', 'node'],
            typescript: ['ts'],
            python: ['py']
          };
          const allowed = equivalents[expectedLang] || [expectedLang];
          if (!allowed.includes(block.language.toLowerCase())) {
            violations.push({
              type: 'output',
              severity: 'high',
              field: 'codeBlocks.language',
              message: `语言不匹配: 预期 ${expectedLang}, 实际 ${block.language} (${block.filePath})`
            });
          }
        }
      }
    }

    // 3. 文件结构验证
    if (expectedContract.expectedFiles && Array.isArray(expectedContract.expectedFiles)) {
      const actualFiles = (output.codeBlocks || []).map(b => b.filePath);
      for (const expectedFile of expectedContract.expectedFiles) {
        if (!actualFiles.some(f => f.includes(expectedFile) || expectedFile.includes(f))) {
          violations.push({
            type: 'output',
            severity: 'medium',
            field: 'files',
            message: `缺少预期文件: ${expectedFile}`
          });
        }
      }
    }

    // 4. 成功标志验证
    if (output.success === false) {
      violations.push({ type: 'output', severity: 'critical', field: 'success', message: '任务执行失败' });
    }

    return this._buildResult(violations, 'output');
  }

  // ═══════════════════════════════════════════
  // 接口契约验证（Agent 间数据传递）
  // ═══════════════════════════════════════════

  validateInterface (data, fromAgent, toAgent, schema = {}) {
    const violations = [];

    // 基本字段检查
    const requiredFields = schema.required || [];
    for (const field of requiredFields) {
      if (data[field] === undefined || data[field] === null) {
        violations.push({
          type: 'interface',
          severity: 'high',
          field,
          message: `${fromAgent} -> ${toAgent}: 缺少必需字段 ${field}`
        });
      }
    }

    // 类型检查
    if (schema.properties) {
      for (const [field, typeDef] of Object.entries(schema.properties)) {
        if (data[field] !== undefined) {
          const actualType = Array.isArray(data[field]) ? 'array' : typeof data[field];
          if (typeDef.type && actualType !== typeDef.type) {
            violations.push({
              type: 'interface',
              severity: 'medium',
              field,
              message: `${fromAgent} -> ${toAgent}: 字段 ${field} 类型不匹配 (预期 ${typeDef.type}, 实际 ${actualType})`
            });
          }
        }
      }
    }

    return this._buildResult(violations, 'interface');
  }

  // ═══════════════════════════════════════════
  // 适配器契约验证
  // ═══════════════════════════════════════════

  validateAdapterOutput (result) {
    const violations = [];

    // 必需字段
    const requiredFields = ['taskId', 'tool', 'success', 'exitCode', 'startTime', 'endTime', 'content'];
    for (const field of requiredFields) {
      if (result[field] === undefined) {
        violations.push({
          type: 'adapter',
          severity: 'high',
          field,
          message: `适配器输出缺少必需字段: ${field}`
        });
      }
    }

    // 类型检查
    if (result.success !== undefined && typeof result.success !== 'boolean') {
      violations.push({ type: 'adapter', severity: 'medium', field: 'success', message: 'success 应为 boolean 类型' });
    }
    if (result.exitCode !== undefined && typeof result.exitCode !== 'number') {
      violations.push({ type: 'adapter', severity: 'medium', field: 'exitCode', message: 'exitCode 应为 number 类型' });
    }
    if (result.generatedFiles && !Array.isArray(result.generatedFiles)) {
      violations.push({ type: 'adapter', severity: 'medium', field: 'generatedFiles', message: 'generatedFiles 应为 array 类型' });
    }
    if (result.codeBlocks && !Array.isArray(result.codeBlocks)) {
      violations.push({ type: 'adapter', severity: 'medium', field: 'codeBlocks', message: 'codeBlocks 应为 array 类型' });
    }

    // 时间一致性
    if (result.startTime && result.endTime && result.endTime < result.startTime) {
      violations.push({ type: 'adapter', severity: 'high', field: 'time', message: 'endTime 早于 startTime' });
    }

    return this._buildResult(violations, 'adapter');
  }

  // ═══════════════════════════════════════════
  // 契约组装验证
  // ═══════════════════════════════════════════

  validateContractAssembly (contract) {
    const violations = [];

    if (!contract.task) {
      violations.push({ type: 'assembly', severity: 'critical', field: 'task', message: '契约缺少 task 定义' });
    }
    if (!contract.constraints) {
      violations.push({ type: 'assembly', severity: 'medium', field: 'constraints', message: '契约缺少 constraints 定义' });
    }
    if (!contract.context) {
      violations.push({ type: 'assembly', severity: 'low', field: 'context', message: '契约缺少 context 定义' });
    }

    // 检查约束一致性
    if (contract.constraints?.language && contract.task?.language) {
      if (contract.constraints.language.toLowerCase() !== contract.task.language.toLowerCase()) {
        violations.push({
          type: 'assembly',
          severity: 'high',
          field: 'constraints.language',
          message: `约束语言(${contract.constraints.language})与任务语言(${contract.task.language})不一致`
        });
      }
    }

    return this._buildResult(violations, 'assembly');
  }

  // ═══════════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════════

  _buildResult (violations, contractType) {
    const critical = violations.filter(v => v.severity === 'critical');
    const high = violations.filter(v => v.severity === 'high');
    const passed = this.strictMode ? violations.length === 0 : critical.length === 0;

    const result = {
      passed,
      contractType,
      violations,
      criticalCount: critical.length,
      highCount: high.length,
      totalViolations: violations.length
    };

    if (violations.length > 0) {
      this.violationHistory.push({ ...result, timestamp: Date.now() });
      if (this.violationHistory.length > this._maxHistory) {
        this.violationHistory.shift();
      }
      logger.warn(`[ContractValidator] ${contractType} 契约违约: ${violations.length}个问题 (${critical.length} critical, ${high.length} high)`);
    }

    return result;
  }

  /**
   * 获取违约统计
   */
  getViolationStats () {
    const stats = { total: this.violationHistory.length, byType: {}, bySeverity: {} };
    for (const entry of this.violationHistory) {
      stats.byType[entry.contractType] = (stats.byType[entry.contractType] || 0) + 1;
      for (const v of entry.violations) {
        stats.bySeverity[v.severity] = (stats.bySeverity[v.severity] || 0) + 1;
      }
    }
    return stats;
  }

  /**
   * 获取最近的违约记录
   */
  getRecentViolations (limit = 20) {
    return this.violationHistory.slice(-limit);
  }
}

module.exports = ContractValidator;
