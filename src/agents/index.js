const BaseAgent = require('./BaseAgent');
const TaskSplitterAgent = require('./TaskSplitterAgent');
const CodeWriterAgent = require('./CodeWriterAgent');
const CodeReviewerAgent = require('./CodeReviewerAgent');
const TesterAgent = require('./TesterAgent');
const QualityCheckerAgent = require('./QualityCheckerAgent');
const MergeEngine = require('./MergeEngine');

class AgentFactory {
  static createAgent(type, provider, options = {}) {
    switch (type) {
      case 'splitter':
      case 'task_splitter':
        return new TaskSplitterAgent(provider, options);
      case 'writer':
      case 'code_writer':
        return new CodeWriterAgent(provider, options);
      case 'reviewer':
      case 'code_reviewer':
        return new CodeReviewerAgent(provider, options);
      case 'tester':
        return new TesterAgent(provider, options);
      case 'quality':
      case 'quality_checker':
        return new QualityCheckerAgent(provider, options);
      case 'merge':
      case 'merge_engine':
        return new MergeEngine(provider, options);
      default:
        throw new Error(`未知的 Agent 类型: ${type}`);
    }
  }

  static createAll(provider, options = {}) {
    return {
      splitter: new TaskSplitterAgent(provider, options.splitter),
      codeWriter: new CodeWriterAgent(provider, options.codeWriter),
      codeReviewer: new CodeReviewerAgent(provider, options.codeReviewer),
      tester: new TesterAgent(provider, options.tester),
      qualityChecker: new QualityCheckerAgent(provider, options.qualityChecker),
      mergeEngine: new MergeEngine(provider, options.mergeEngine)
    };
  }
}

module.exports = AgentFactory;
