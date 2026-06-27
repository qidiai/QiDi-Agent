/**
 * 任务路由引擎：决定每个子任务应该派发给哪个工具。
 * 支持三种路由策略：
 * - round_robin：轮询分发，每个工具轮流执行
 * - capability：根据工具能力智能匹配
 * - manual：根据预定义路由表手动指定
 * 
 * 隐私保护原理：
 * - 每个子任务只发给一个工具
 * - 工具之间互不知道其他工具的产出
 * - Provider 只负责拆分和质检，不参与代码生成
 */

class TaskRouter {
  constructor(adapters = [], options = {}) {
    this.adapters = adapters;
    this.options = {
      strategy: options.strategy || 'round_robin',
      // 手动路由表：任务类型 -> 工具名称
      manualRouting: options.manualRouting || {},
      // 工具能力表：工具名称 -> 支持的能力
      capabilities: options.capabilities || this._buildDefaultCapabilities(),
      roundRobinIndex: 0,
      // 隐私模式：Provider 是否参与代码生成
      privacyMode: options.privacyMode !== false,
      // 是否仅使用工具执行（不依赖 Provider 生成）
      toolOnlyMode: options.toolOnlyMode || false,
      ...options
    };
  }

  /**
   * 获取可用的适配器列表
   */
  getAvailableAdapters() {
    return this.adapters.filter(a => a.isAvailable && a.isAvailable());
  }

  /**
   * 获取路由策略列表
   */
  getStrategies() {
    return [
      {
        name: 'round_robin',
        description: '轮询模式 - 依次分发给每个工具，每个工具只执行部分任务',
        privacyLevel: 'high',
        providerInvolved: false
      },
      {
        name: 'capability',
        description: '能力匹配 - 根据任务类型/语言/复杂度智能匹配最佳工具',
        privacyLevel: 'high',
        providerInvolved: false
      },
      {
        name: 'manual',
        description: '手动指定 - 通过路由表精确控制每个任务类型派发给哪个工具',
        privacyLevel: 'high',
        providerInvolved: false
      },
      {
        name: 'broadcast',
        description: '广播模式（传统）- 所有工具都执行所有任务，用于质量比较',
        privacyLevel: 'low',
        providerInvolved: true
      }
    ];
  }

  /**
   * 默认工具能力表
   */
  _buildDefaultCapabilities() {
    return {
      'claude-code': {
        languages: ['python', 'javascript', 'typescript', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'php', 'ruby'],
        frameworks: ['react', 'vue', 'angular', 'next', 'django', 'flask', 'express', 'fastapi', 'spring', 'laravel'],
        strengths: ['architecture', 'complexity', 'testing', 'security', 'performance'],
        maxComplexity: 'high',
        roles: ['architect', 'code_writer', 'code_reviewer'],
        description: 'Claude Code - Anthropic 的 AI 编程工具'
      },
      'open-code': {
        languages: ['python', 'javascript', 'typescript', 'go', 'rust'],
        frameworks: ['react', 'vue', 'express', 'fastapi', 'next'],
        strengths: ['code_generation', 'refactoring', 'documentation'],
        maxComplexity: 'medium',
        roles: ['code_writer', 'tester'],
        description: 'Open Code - 开源 AI 编程工具'
      },
      'openclaw': {
        languages: ['python', 'javascript', 'typescript', 'lua', 'go'],
        frameworks: ['love2d', 'defold', 'unity'],
        strengths: ['game_dev', 'scripting', 'automation'],
        maxComplexity: 'medium',
        roles: ['code_writer', 'tester'],
        description: 'OpenClaw - 游戏开发专用 AI 工具'
      },
      'qoder': {
        languages: ['python', 'javascript', 'typescript', 'bash'],
        frameworks: ['flask', 'express', 'django'],
        strengths: ['quick_prototypes', 'scripting', 'cli_tools'],
        maxComplexity: 'low',
        roles: ['code_writer'],
        description: 'Qoder - 轻量级 AI 编程助手'
      },
      'hermes-agent': {
        languages: ['python', 'javascript', 'typescript', 'go', 'rust'],
        frameworks: ['react', 'vue', 'fastapi', 'django'],
        strengths: ['api_design', 'backend', 'integrations'],
        maxComplexity: 'medium',
        roles: ['code_writer', 'code_reviewer'],
        description: 'Hermes Agent - 企业级 AI 助手'
      },
      'atom-code': {
        languages: ['python', 'javascript', 'typescript', 'java'],
        frameworks: ['react', 'angular', 'vue'],
        strengths: ['frontend', 'mobile', 'responsive'],
        maxComplexity: 'medium',
        roles: ['code_writer'],
        description: 'AtomCode - 移动开发专用'
      },
      'mimo-code': {
        languages: ['python', 'javascript', 'typescript', 'html', 'css'],
        frameworks: ['react', 'vue', 'svelte'],
        strengths: ['learning', 'tutorials', 'beginner_friendly'],
        maxComplexity: 'low',
        roles: ['code_writer', 'tester'],
        description: 'Mimo Code - 学习友好的编程助手'
      },
      'trae': {
        languages: ['python', 'javascript', 'typescript', 'go', 'rust', 'java'],
        frameworks: ['react', 'vue', 'next', 'fastapi', 'spring'],
        strengths: ['fullstack', 'architecture', 'enterprise'],
        maxComplexity: 'high',
        roles: ['architect', 'code_writer', 'code_reviewer'],
        description: 'Trae CN - 国产 AI 编程工具'
      }
    };
  }

  /**
   * 更新工具能力表
   */
  setCapabilities(capabilities) {
    this.options.capabilities = { ...this.options.capabilities, ...capabilities };
  }

  /**
   * 设置手动路由表
   */
  setManualRouting(routingTable) {
    this.options.manualRouting = { ...this.options.manualRouting, ...routingTable };
  }

  /**
   * 根据任务为每个子任务分配工具
   * @param {Array} tasks - 子任务列表
   * @returns {Array} - 每个任务分配的适配器信息
   */
  routeTasks(tasks) {
    const available = this.getAvailableAdapters();
    if (available.length === 0) {
      return tasks.map(t => ({ task: t, adapter: null, reason: '无可用工具' }));
    }

    const results = [];
    for (const task of tasks) {
      const result = this.routeTask(task);
      results.push({
        task,
        adapter: result.adapter,
        reason: result.reason,
        strategy: this.options.strategy
      });
    }

    // 重置轮询索引（每次路由任务列表后重置）
    if (this.options.strategy === 'round_robin') {
      this.options.roundRobinIndex = 0;
    }

    return results;
  }

  /**
   * 为单个任务选择工具
   */
  routeTask(task) {
    const available = this.getAvailableAdapters();
    if (available.length === 0) {
      return { adapter: null, reason: '无可用工具' };
    }

    switch (this.options.strategy) {
      case 'round_robin':
        return this._routeRoundRobin(task, available);
      case 'capability':
        return this._routeByCapability(task, available);
      case 'manual':
        return this._routeManual(task, available);
      case 'broadcast':
        return { adapter: available, reason: '广播模式：所有工具执行', isBroadcast: true };
      default:
        return this._routeRoundRobin(task, available);
    }
  }

  /**
   * 轮询路由：按顺序轮流分配给不同工具
   * 隐私保护：每个工具只拿到部分任务
   */
  _routeRoundRobin(task, available) {
    const adapter = available[this.options.roundRobinIndex % available.length];
    const toolName = adapter.displayName || adapter.name;
    this.options.roundRobinIndex++;

    return {
      adapter,
      reason: `轮询策略：分配给 ${toolName}（第${this.options.roundRobinIndex}个任务）`,
      strategy: 'round_robin',
      assignedIndex: this.options.roundRobinIndex - 1
    };
  }

  /**
   * 能力匹配路由：根据任务复杂度、语言、框架匹配最佳工具
   * 隐私保护：根据能力分配，工具只执行适合的任务
   */
  _routeByCapability(task, available) {
    const scores = available.map(adapter => {
      const caps = this.options.capabilities[adapter.name] || {};
      const score = this._calculateCapabilityScore(task, caps);

      return {
        adapter,
        score,
        caps,
        reason: this._explainCapabilityMatch(task, caps, score)
      };
    });

    // 按得分排序
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];

    return {
      adapter: best.adapter,
      reason: best.reason,
      strategy: 'capability',
      score: best.score,
      allScores: scores.map(s => ({
        tool: s.adapter.name,
        score: s.score
      }))
    };
  }

  /**
   * 计算任务与工具能力的匹配度
   */
  _calculateCapabilityScore(task, caps) {
    let score = 0;
    const details = [];

    // 1. 语言匹配（最高3分）
    if (task.language && caps.languages) {
      if (caps.languages.includes(task.language)) {
        score += 3;
        details.push(`语言匹配: ${task.language}`);
      }
    }

    // 2. 框架匹配（最高6分，每匹配一个+2）
    if (task.frameworks && task.frameworks.length > 0 && caps.frameworks) {
      const frameworkMatches = task.frameworks.filter(f => 
        caps.frameworks.some(cf => cf.toLowerCase() === f.toLowerCase())
      );
      score += Math.min(frameworkMatches.length * 2, 6);
      if (frameworkMatches.length > 0) {
        details.push(`框架匹配: ${frameworkMatches.join(', ')}`);
      }
    }

    // 3. 角色匹配（最高3分）
    if (task.role && caps.roles) {
      if (caps.roles.includes(task.role)) {
        score += 3;
        details.push(`角色匹配: ${task.role}`);
      }
    }

    // 4. 复杂度匹配（最高2分）
    if (task.complexity && caps.maxComplexity) {
      const complexityScore = this._getComplexityScore(task.complexity, caps.maxComplexity);
      score += complexityScore;
      if (complexityScore > 0) {
        details.push(`复杂度: ${task.complexity} (工具支持: ${caps.maxComplexity})`);
      }
    }

    // 5. 优势匹配（最高4分）
    if (task.requiredStrengths && task.requiredStrengths.length > 0 && caps.strengths) {
      const strengthMatches = task.requiredStrengths.filter(s => 
        caps.strengths.some(cs => cs.toLowerCase() === s.toLowerCase())
      );
      score += Math.min(strengthMatches.length * 2, 4);
      if (strengthMatches.length > 0) {
        details.push(`优势匹配: ${strengthMatches.join(', ')}`);
      }
    }

    return score;
  }

  /**
   * 获取复杂度匹配分数
   */
  _getComplexityScore(taskComplexity, maxComplexity) {
    const levels = { low: 1, medium: 2, high: 3 };
    const taskLevel = levels[taskComplexity] || 2;
    const maxLevel = levels[maxComplexity] || 2;

    if (taskLevel <= maxLevel) {
      return taskLevel === maxLevel ? 2 : 1;
    }
    return 0;
  }

  /**
   * 解释能力匹配原因
   */
  _explainCapabilityMatch(task, caps, score) {
    const toolName = caps.description || caps.name || '未知工具';
    const matches = [];

    if (task.language && caps.languages?.includes(task.language)) {
      matches.push(`支持${task.language}`);
    }

    if (task.frameworks && task.frameworks.length > 0 && caps.frameworks) {
      const matched = task.frameworks.filter(f => 
        caps.frameworks.some(cf => cf.toLowerCase() === f.toLowerCase())
      );
      if (matched.length > 0) matches.push(`熟悉${matched.join(', ')}`);
    }

    if (task.role && caps.roles?.includes(task.role)) {
      matches.push(`适合${task.role}角色`);
    }

    if (caps.strengths && caps.strengths.length > 0) {
      matches.push(`优势: ${caps.strengths.slice(0, 2).join(', ')}`);
    }

    return `${toolName}（得分: ${score}）${matches.length > 0 ? '- ' + matches.join('; ') : ''}`;
  }

  /**
   * 手动路由：根据预定义路由表分配
   * 隐私保护：精确控制每个任务类型的去向
   */
  _routeManual(task, available) {
    const toolName = this.options.manualRouting[task.role];

    if (!toolName) {
      // 未找到对应路由，降级到轮询
      return this._routeRoundRobin(task, available);
    }

    const adapter = available.find(a => a.name === toolName);

    if (!adapter) {
      // 指定工具不可用，降级到轮询
      return this._routeRoundRobin(task, available);
    }

    return {
      adapter,
      reason: `手动指定: ${task.role} → ${adapter.displayName || adapter.name}`,
      strategy: 'manual',
      originalMapping: `${task.role} -> ${toolName}`
    };
  }

  /**
   * 获取路由统计信息
   */
  getRoutingStats(routedTasks) {
    const stats = {
      totalTasks: routedTasks.length,
      assignedTasks: routedTasks.filter(r => r.adapter !== null).length,
      unassignedTasks: routedTasks.filter(r => r.adapter === null).length,
      byTool: {},
      byRole: {},
      byStrategy: this.options.strategy,
      privacyMode: this.options.privacyMode
    };

    for (const r of routedTasks) {
      if (r.adapter) {
        const toolName = r.adapter.name;
        const role = r.task.role;

        // 按工具统计
        if (!stats.byTool[toolName]) {
          stats.byTool[toolName] = { count: 0, tasks: [] };
        }
        stats.byTool[toolName].count++;
        stats.byTool[toolName].tasks.push(r.task.title);

        // 按角色统计
        if (!stats.byRole[role]) {
          stats.byRole[role] = { count: 0, tools: new Set() };
        }
        stats.byRole[role].count++;
        stats.byRole[role].tools.add(toolName);
      }
    }

    // 转换 Set 为 Array
    for (const role of Object.keys(stats.byRole)) {
      stats.byRole[role].tools = Array.from(stats.byRole[role].tools);
    }

    return stats;
  }

  /**
   * 验证路由配置是否合理
   */
  validateRouting(routedTasks) {
    const issues = [];

    // 检查是否有任务未分配
    const unassigned = routedTasks.filter(r => r.adapter === null);
    if (unassigned.length > 0) {
      issues.push(`有 ${unassigned.length} 个任务未分配工具`);
    }

    // 检查是否有任务分配给了不存在的工具
    const availableNames = this.getAvailableAdapters().map(a => a.name);
    const invalidAssignments = routedTasks.filter(r => 
      r.adapter && !availableNames.includes(r.adapter.name)
    );
    if (invalidAssignments.length > 0) {
      issues.push(`有 ${invalidAssignments.length} 个任务分配给了不存在的工具`);
    }

    // 检查负载是否均衡（标准差不应过大）
    if (routedTasks.length > 0) {
      const toolCounts = {};
      for (const r of routedTasks) {
        if (r.adapter) {
          const name = r.adapter.name;
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
      const counts = Object.values(toolCounts);
      if (counts.length > 1) {
        const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
        const variance = counts.reduce((sum, c) => sum + Math.pow(c - avg, 2), 0) / counts.length;
        const stdDev = Math.sqrt(variance);
        if (stdDev > avg * 0.5) {
          issues.push(`任务分配不均衡（标准差: ${stdDev.toFixed(2)}，平均值: ${avg.toFixed(2)}）`);
        }
      }
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }
}

module.exports = TaskRouter;
