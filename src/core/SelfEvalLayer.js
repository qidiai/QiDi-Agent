const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const EmergenceEvaluator = require('./EmergenceEvaluator');

class SelfEvalLayer {
  constructor (options = {}) {
    this.evalHistory = [];
    this.adaptiveParams = {
      taskClassifier: {
        pathWeight: 0.8,
        codeWeight: 0.6,
        chatThreshold: 0.3
      },
      taskRouter: {
        topN: 3,
        minScore: 0.5,
        broadcastThreshold: 0.7
      },
      systemPrompt: {
        verbosity: 'medium',
        toolMentionEnabled: true,
        fileOpsEnabled: true
      },
      retryPolicy: {
        maxRetries: 2,
        backoffFactor: 1.5
      }
    };

    this.feedbackCounts = {
      thumbsUp: 0,
      thumbsDown: 0,
      reexecutions: 0
    };

    this.evalStats = {
      totalTasks: 0,
      avgQuality: 0,
      improvementRate: 0
    };

    this.historyFile = options.historyFile || path.join(__dirname, '../data/self_eval_history.json');
    this.paramsFile = options.paramsFile || path.join(__dirname, '../data/adaptive_params.json');

    this._loadHistory();
    this._loadParams();

    this.emergenceEvaluator = options.emergenceEvaluator || new EmergenceEvaluator();

    this.evaluationRules = [
      this._evalByOutputQuality.bind(this),
      this._evalByExecutionTime.bind(this),
      this._evalByToolUsage.bind(this),
      this._evalByUserFeedback.bind(this),
      this._evalByEmergence.bind(this)
    ];
  }

  _loadHistory () {
    try {
      if (fs.existsSync(this.historyFile)) {
        const data = JSON.parse(fs.readFileSync(this.historyFile, 'utf-8'));
        this.evalHistory = data.history || [];
        this.feedbackCounts = data.feedbackCounts || this.feedbackCounts;
        this.evalStats = data.stats || this.evalStats;
      }
    } catch (e) {
      logger.warn('[SelfEval] 加载历史记录失败', e.message);
    }
  }

  _loadParams () {
    try {
      if (fs.existsSync(this.paramsFile)) {
        const data = JSON.parse(fs.readFileSync(this.paramsFile, 'utf-8'));
        this.adaptiveParams = { ...this.adaptiveParams, ...data };
      }
    } catch (e) {
      logger.warn('[SelfEval] 加载自适应参数失败', e.message);
    }
  }

  _saveHistory () {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        history: this.evalHistory.slice(-100),
        feedbackCounts: this.feedbackCounts,
        stats: this.evalStats
      };
      fs.writeFileSync(this.historyFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      logger.warn('[SelfEval] 保存历史记录失败', e.message);
    }
  }

  _saveParams () {
    try {
      const dir = path.dirname(this.paramsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.paramsFile, JSON.stringify(this.adaptiveParams, null, 2), 'utf-8');
    } catch (e) {
      logger.warn('[SelfEval] 保存自适应参数失败', e.message);
    }
  }

  async evaluate (taskResult) {
    this.evalStats.totalTasks++;

    const scores = [];
    for (const rule of this.evaluationRules) {
      const score = await rule(taskResult);
      scores.push(score);
    }

    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    const evaluation = {
      taskId: taskResult.taskId,
      taskType: taskResult.taskType || 'unknown',
      scores: {
        outputQuality: scores[0],
        executionTime: scores[1],
        toolUsage: scores[2],
        userFeedback: scores[3],
        emergence: scores[4] || 0.5
      },
      overallScore: avgScore,
      timestamp: Date.now(),
      modelUsed: taskResult.model,
      toolsUsed: taskResult.tools || []
    };

    this.evalHistory.push(evaluation);
    this.evalStats.avgQuality = (this.evalStats.avgQuality * (this.evalStats.totalTasks - 1) + avgScore) / this.evalStats.totalTasks;

    await this._adapt(evaluation);
    this._saveHistory();

    return evaluation;
  }

  _evalByOutputQuality (taskResult) {
    const output = taskResult.output || [];
    const combinedOutput = output.join('');

    let score = 0.5;

    if (combinedOutput.includes('❌')) {
      score -= 0.2;
    }
    if (combinedOutput.includes('✅')) {
      score += 0.15;
    }
    if (combinedOutput.includes('错误') || combinedOutput.includes('error')) {
      score -= 0.15;
    }
    if (combinedOutput.length > 500) {
      score += 0.1;
    }
    if (combinedOutput.includes('分析') || combinedOutput.includes('完成')) {
      score += 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  _evalByExecutionTime (taskResult) {
    const duration = taskResult.duration || 30000;

    if (duration < 10000) return 0.9;
    if (duration < 30000) return 0.7;
    if (duration < 60000) return 0.5;
    if (duration < 120000) return 0.3;
    return 0.1;
  }

  _evalByToolUsage (taskResult) {
    const toolsUsed = taskResult.tools || [];

    if (toolsUsed.length === 0) return 0.3;
    if (toolsUsed.length === 1) return 0.5;
    if (toolsUsed.length === 2) return 0.7;
    if (toolsUsed.length >= 3) return 0.9;

    return 0.4;
  }

  _evalByUserFeedback (taskResult) {
    const feedback = taskResult.feedback || 'neutral';

    switch (feedback) {
    case 'thumbsUp': return 0.9;
    case 'thumbsDown': return 0.2;
    case 'reexecute': return 0.3;
    default: return 0.5;
    }
  }

  _evalByEmergence (taskResult) {
    if (!taskResult.emergence) return 0.5;
    const e = taskResult.emergence;
    if (e.verdict === 'EMERGENT') return 1.0;
    if (e.verdict === 'MARGINAL') return 0.7;
    if (e.verdict === 'NEGATIVE') return 0.2;
    return 0.5;
  }

  async _adapt (evaluation) {
    const { overallScore } = evaluation;

    if (overallScore < 0.3) {
      logger.info('[SelfEval] 检测到低质量输出，触发自适应调整');
      await this._handleLowQuality(evaluation);
    } else if (overallScore > 0.8) {
      logger.info('[SelfEval] 检测到高质量输出，强化当前策略');
      await this._handleHighQuality(evaluation);
    }

    this._saveParams();
  }

  async _handleLowQuality (evaluation) {
    if (evaluation.scores.toolUsage < 0.5) {
      logger.info('[SelfEval] 工具使用不足，提高路由topN');
      this.adaptiveParams.taskRouter.topN = Math.min(5, this.adaptiveParams.taskRouter.topN + 1);
      this.adaptiveParams.taskRouter.minScore = Math.max(0.3, this.adaptiveParams.taskRouter.minScore - 0.1);
    }

    if (evaluation.scores.outputQuality < 0.3) {
      logger.info('[SelfEval] 输出质量低，调整系统提示词');
      this.adaptiveParams.systemPrompt.verbosity = 'high';
      this.adaptiveParams.systemPrompt.toolMentionEnabled = true;
      this.adaptiveParams.systemPrompt.fileOpsEnabled = true;
    }

    if (evaluation.scores.executionTime < 0.3) {
      logger.info('[SelfEval] 执行超时，增加重试次数');
      this.adaptiveParams.retryPolicy.maxRetries = Math.min(5, this.adaptiveParams.retryPolicy.maxRetries + 1);
    }
  }

  async _handleHighQuality (evaluation) {
    if (evaluation.scores.toolUsage > 0.7) {
      logger.info('[SelfEval] 工具使用良好，保持策略');
      this.adaptiveParams.taskRouter.topN = Math.max(2, this.adaptiveParams.taskRouter.topN);
    }

    if (evaluation.scores.outputQuality > 0.8) {
      logger.info('[SelfEval] 输出质量高，可适当降低提示词详细度');
      this.adaptiveParams.systemPrompt.verbosity = 'medium';
    }
  }

  recordFeedback (taskId, feedbackType) {
    if (feedbackType === 'thumbsUp') {
      this.feedbackCounts.thumbsUp++;
    } else if (feedbackType === 'thumbsDown') {
      this.feedbackCounts.thumbsDown++;
    } else if (feedbackType === 'reexecute') {
      this.feedbackCounts.reexecutions++;
    }

    this._saveHistory();

    const ratio = this.feedbackCounts.thumbsUp / (this.feedbackCounts.thumbsUp + this.feedbackCounts.thumbsDown || 1);
    logger.info(`[SelfEval] 反馈记录: 👍${this.feedbackCounts.thumbsUp} 👎${this.feedbackCounts.thumbsDown} 重执${this.feedbackCounts.reexecutions} 好评率: ${(ratio * 100).toFixed(1)}%`);

    return { ratio, counts: this.feedbackCounts };
  }

  getAdaptiveParams () {
    return JSON.parse(JSON.stringify(this.adaptiveParams));
  }

  getStats () {
    return {
      totalTasks: this.evalStats.totalTasks,
      avgQuality: parseFloat(this.evalStats.avgQuality.toFixed(3)),
      feedback: this.feedbackCounts,
      improvementRate: parseFloat(this.evalStats.improvementRate.toFixed(3))
    };
  }

  getSystemPrompt () {
    const promptConfig = this.adaptiveParams.systemPrompt;

    const basePrompt = '你叫 QIDI Agent（启迪智能体），是一个多模型协同编程助手。';

    const capabilitySection = promptConfig.verbosity === 'high'
      ? '\n\n1. 多模型协同：同时调用多个 AI 模型（Ollama、OpenAI、Claude 等）协同完成编程任务\n2. 智能路由：根据任务类型自动选择合适的模型和工具\n3. 代码生成：支持 C、Python、TypeScript、Go、Rust、Java 等多语言代码生成\n4. 隐私模式：代码碎片化分发，敏感信息不出本地\n5. 高质量模式：调用多个云端模型协同编排，输出代码质量对标国际前沿模型\n6. 任务编排：自动分解复杂任务，按序执行子任务'
      : '\n\n你具备多模型协同、智能路由、代码生成、任务编排等核心能力。';

    const fileOpsSection = promptConfig.fileOpsEnabled
      ? '\n\n关键能力说明：\n- 当用户提供文件路径（如 C:\\Users\\xxx\\project 或 ./workspace）时，你可以直接分析该路径下的文件\n- 你可以读取项目的目录结构、源代码文件内容\n- 你可以理解项目的业务逻辑、架构设计和代码实现\n- 你有完整的文件系统访问能力，不是只能通过文本对话'
      : '';

    const instructionSection = promptConfig.verbosity === 'high'
      ? '\n\n回答策略：\n- 先理解用户意图，再回答。不要急于输出，先分析用户的核心需求\n- 当用户提供文件路径时，立即开始分析，不要询问"你无法访问本地文件"\n- 复杂问题先拆解，再逐一解决。主动识别潜在问题并提醒用户\n- 代码生成前，先确认需求细节；实现后主动提供测试建议\n- 不确定时，诚实告知用户，而非猜测或编造\n- 定期总结进度和下一步计划\n- 保持对话上下文连贯，记住之前的对话内容'
      : '\n\n回答策略：理解用户意图，分析核心需求，主动解决问题。';

    return basePrompt + capabilitySection + fileOpsSection + instructionSection;
  }

  reset () {
    this.evalHistory = [];
    this.feedbackCounts = { thumbsUp: 0, thumbsDown: 0, reexecutions: 0 };
    this.evalStats = { totalTasks: 0, avgQuality: 0, improvementRate: 0 };
    this.adaptiveParams = {
      taskClassifier: { pathWeight: 0.8, codeWeight: 0.6, chatThreshold: 0.3 },
      taskRouter: { topN: 3, minScore: 0.5, broadcastThreshold: 0.7 },
      systemPrompt: { verbosity: 'medium', toolMentionEnabled: true, fileOpsEnabled: true },
      retryPolicy: { maxRetries: 2, backoffFactor: 1.5 }
    };
    this._saveHistory();
    this._saveParams();
    logger.info('[SelfEval] 已重置所有评估数据和参数');
  }
}

module.exports = SelfEvalLayer;
