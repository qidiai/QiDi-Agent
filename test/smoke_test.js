const fs = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, '../test_output');
const WORKSPACE_DIR = path.join(__dirname, '../workspace');

const results = {
  timestamp: new Date().toISOString(),
  tests: [],
  summary: {}
};

function test(name, fn) {
  return async () => {
    const start = Date.now();
    try {
      await fn();
      const duration = Date.now() - start;
      results.tests.push({ name, status: 'PASS', duration });
      console.log(`✅ ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - start;
      results.tests.push({ name, status: 'FAIL', duration, error: error.message });
      console.log(`❌ ${name}: ${error.message}`);
    }
  };
}

async function runTests() {
  console.log('\n🚀 AI Orchestrator 冒烟测试\n');
  console.log('='.repeat(50));
  console.log('');

  const tests = [
    test('01. 项目结构完整性', async () => {
      const expectedFiles = [
        'src/providers/BaseProvider.js',
        'src/providers/OllamaProvider.js',
        'src/providers/OpenAIProvider.js',
        'src/providers/index.js',
        'src/agents/BaseAgent.js',
        'src/agents/TaskSplitterAgent.js',
        'src/agents/CodeWriterAgent.js',
        'src/agents/CodeReviewerAgent.js',
        'src/agents/TesterAgent.js',
        'src/agents/QualityCheckerAgent.js',
        'src/agents/index.js',
        'src/core/TaskOrchestrator.js',
        'src/utils/FileManager.js',
        'src/cli/index.js',
        'package.json',
        '.env.example'
      ];

      expectedFiles.forEach(file => {
        const fullPath = path.join(__dirname, '../', file);
        if (!fs.existsSync(fullPath)) {
          throw new Error(`缺失文件: ${file}`);
        }
      });
    }),

    test('02. 模块导入测试 - providers', async () => {
      const { default: ProviderFactory } = await import('../src/providers/index.js');
      if (!ProviderFactory || typeof ProviderFactory.create !== 'function') {
        throw new Error('ProviderFactory 创建失败');
      }
    }),

    test('03. 模块导入测试 - agents', async () => {
      const { default: AgentFactory } = await import('../src/agents/index.js');
      if (!AgentFactory || typeof AgentFactory.createAgent !== 'function') {
        throw new Error('AgentFactory 创建失败');
      }
    }),

    test('04. 模块导入测试 - core', async () => {
      const { default: TaskOrchestrator } = await import('../src/core/TaskOrchestrator.js');
      if (!TaskOrchestrator) {
        throw new Error('TaskOrchestrator 导入失败');
      }
    }),

    test('05. 模块导入测试 - utils', async () => {
      const { default: FileManager } = await import('../src/utils/FileManager.js');
      if (!FileManager) {
        throw new Error('FileManager 导入失败');
      }
    }),

    test('06. FileManager 功能测试', async () => {
      const { default: FileManager } = await import('../src/utils/FileManager.js');
      const fm = new FileManager(TEST_DIR);

      const testFile = 'test_write.txt';
      const content = 'Hello, World!';
      fm.writeFile(testFile, content);

      const readContent = fm.readFile(testFile);
      if (readContent !== content) {
        throw new Error('文件读写不一致');
      }

      const exists = fm.fileExists(testFile);
      if (!exists) {
        throw new Error('文件存在检查失败');
      }

      const files = fm.listFiles('.');
      if (!files.includes(testFile)) {
        throw new Error('文件列表获取失败');
      }

      const tree = fm.getFileTree('.', 2);
      if (!tree.includes('test_write.txt')) {
        throw new Error('文件树获取失败');
      }

      fs.rmSync(path.join(TEST_DIR, testFile));
    }),

    test('07. ProviderFactory 创建 OllamaProvider', async () => {
      const { default: ProviderFactory } = await import('../src/providers/index.js');
      const provider = ProviderFactory.create('ollama', {
        baseUrl: 'http://localhost:11434',
        model: 'qwen2.5:7b'
      });

      if (provider.name !== 'ollama') {
        throw new Error('Provider name 不正确');
      }

      if (typeof provider.chat !== 'function') {
        throw new Error('chat 方法不存在');
      }

      if (typeof provider.generate !== 'function') {
        throw new Error('generate 方法不存在');
      }
    }),

    test('08. ProviderFactory 创建 OpenAIProvider', async () => {
      const { default: ProviderFactory } = await import('../src/providers/index.js');
      const provider = ProviderFactory.create('openai', {
        apiKey: 'test-key',
        model: 'gpt-4o-mini'
      });

      if (provider.name !== 'openai') {
        throw new Error('Provider name 不正确');
      }

      if (typeof provider.chat !== 'function') {
        throw new Error('chat 方法不存在');
      }
    }),

    test('08b. ProviderFactory 创建 AnthropicProvider', async () => {
      const { default: ProviderFactory } = await import('../src/providers/index.js');
      const AnthropicProvider = (await import('../src/providers/AnthropicProvider.js')).default;
      const provider = ProviderFactory.create('anthropic', {
        apiKey: 'sk-ant-test-key',
        model: 'claude-3-5-sonnet-20240620'
      });

      if (provider.name !== 'anthropic') {
        throw new Error('Provider name 应为 anthropic');
      }

      if (typeof provider.chat !== 'function') {
        throw new Error('chat 方法不存在');
      }

      if (typeof provider.chatStream !== 'function') {
        throw new Error('chatStream 方法不存在');
      }

      if (typeof provider.listModels !== 'function') {
        throw new Error('listModels 方法不存在');
      }

      // 验证模型列表
      const models = provider.listModels();
      if (!Array.isArray(models) || models.length === 0) {
        throw new Error('模型列表应非空');
      }

      // 验证 API Key 格式检查
      if (!AnthropicProvider.validateApiKey('sk-ant-api01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')) {
        throw new Error('API Key 格式验证失败');
      }
      
      if (AnthropicProvider.validateApiKey('')) {
        throw new Error('空 API Key 应验证失败');
      }
    }),

    test('09. AgentFactory 创建所有 Agent', async () => {
      const { default: AgentFactory } = await import('../src/agents/index.js');
      const mockProvider = {
        chat: async () => ({ content: 'test', role: 'assistant' }),
        generate: async () => ({ content: 'test' })
      };

      const agents = AgentFactory.createAll(mockProvider);

      const expectedAgents = ['splitter', 'codeWriter', 'codeReviewer', 'tester', 'qualityChecker'];
      expectedAgents.forEach(agentName => {
        if (!agents[agentName]) {
          throw new Error(`${agentName} Agent 创建失败`);
        }
      });
    }),

    test('10. TaskOrchestrator 初始化测试', async () => {
      const { default: TaskOrchestrator } = await import('../src/core/TaskOrchestrator.js');
      const mockProvider = {
        chat: async () => ({ content: 'test', role: 'assistant' }),
        generate: async () => ({ content: 'test' }),
        name: 'mock'
      };

      const orchestrator = new TaskOrchestrator(mockProvider, {
        workspaceDir: TEST_DIR
      });

      const initialized = await orchestrator.initialize();
      if (!initialized) {
        throw new Error('初始化失败');
      }

      const status = orchestrator.getStatus();
      if (status.isRunning !== false) {
        throw new Error('初始状态不正确');
      }
    }),

    test('11. CLI 命令行接口测试', async () => {
      const { Command } = await import('commander');
      const program = new Command();

      program
        .command('run')
        .option('-t, --task <task>')
        .option('-p, --provider <provider>')
        .action(() => {});

      program
        .command('check')
        .option('-p, --provider <provider>')
        .action(() => {});

      program
        .command('list')
        .option('-w, --workspace <dir>')
        .action(() => {});

      const commands = program.commands.map(c => c.name());
      if (!commands.includes('run')) throw new Error('run 命令未注册');
      if (!commands.includes('check')) throw new Error('check 命令未注册');
      if (!commands.includes('list')) throw new Error('list 命令未注册');
    }),

    test('12. 配置文件模板检查', async () => {
      const envContent = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf-8');
      
      const requiredConfigs = [
        'MODEL_PROVIDER',
        'OLLAMA_BASE_URL',
        'OLLAMA_MODEL',
        'OPENAI_API_KEY',
        'WORKSPACE_DIR'
      ];

      requiredConfigs.forEach(config => {
        if (!envContent.includes(config)) {
          throw new Error(`配置模板缺少: ${config}`);
        }
      });
    }),

    test('13. package.json 依赖检查', async () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
      
      const requiredDeps = ['chalk', 'commander', 'dotenv', 'inquirer', 'ora'];
      requiredDeps.forEach(dep => {
        if (!pkg.dependencies[dep]) {
          throw new Error(`缺少依赖: ${dep}`);
        }
      });
    }),

    test('14. 工具适配器 - 所有适配器创建', async () => {
      const adapters = require('../src/adapters');
      const allAdapters = adapters.createAll();
      
      if (allAdapters.length !== 8) {
        throw new Error(`适配器数量应为8，实际为${allAdapters.length}`);
      }

      const expectedNames = [
        'claude-code', 'open-code', 'openclaw',
        'qoder', 'hermes-agent', 'atom-code', 'mimo-code', 'trae'
      ];
      
      expectedNames.forEach(name => {
        if (!allAdapters.find(a => a.name === name)) {
          throw new Error(`缺少适配器: ${name}`);
        }
      });
    }),

    test('15. 工具适配器 - 单个适配器创建', async () => {
      const adapters = require('../src/adapters');
      
      const qoder = adapters.create('qoder');
      if (!qoder || qoder.name !== 'qoder') {
        throw new Error('Qoder 适配器创建失败');
      }

      const hermes = adapters.create('hermes-agent');
      if (!hermes || hermes.name !== 'hermes-agent') {
        throw new Error('Hermes Agent 适配器创建失败');
      }
    }),

    test('16. 工具适配器 - BaseToolAdapter 基础功能', async () => {
      const { BaseToolAdapter } = require('../src/adapters');
      
      const adapter = new BaseToolAdapter({
        name: 'test',
        displayName: 'Test Tool',
        command: 'test'
      });

      if (adapter.name !== 'test') throw new Error('name 不正确');
      if (adapter.displayName !== 'Test Tool') throw new Error('displayName 不正确');
      if (adapter.isAvailable() !== false) throw new Error('初始状态应为不可用');
      
      const info = adapter.getInfo();
      if (info.name !== 'test') throw new Error('getInfo 返回不正确');
    }),

    test('17. MultiAgentDispatcher - 模块加载和模式列表', async () => {
      const MultiAgentDispatcher = require('../src/core/MultiAgentDispatcher');
      
      const dispatcher = new MultiAgentDispatcher({
        configDir: path.join(__dirname, '../config')
      });

      const modes = dispatcher.getModes();
      if (modes.length < 4) {
        throw new Error(`模式数量应为>=4，实际为${modes.length}`);
      }

      const modeNames = modes.map(m => m.name);
      const expectedModes = ['parallel', 'sequential', 'select', 'cascade'];
      expectedModes.forEach(mode => {
        if (!modeNames.includes(mode)) {
          throw new Error(`缺少模式: ${mode}`);
        }
      });
    }),

    test('18. QualityCheckerAgent - 静态代码检查', async () => {
      const { default: QualityCheckerAgent } = await import('../src/agents/QualityCheckerAgent.js');
      
      const mockProvider = {
        chat: async () => ({ content: '{"qualityScore": 85, "status": "completed"}', role: 'assistant' })
      };

      const checker = new QualityCheckerAgent(mockProvider);
      
      if (checker.name !== 'QualityChecker') {
        throw new Error('Agent name 不正确');
      }

      if (typeof checker._staticCodeCheck !== 'function') {
        throw new Error('_staticCodeCheck 方法不存在');
      }

      if (typeof checker._calculateMetrics !== 'function') {
        throw new Error('_calculateMetrics 方法不存在');
      }
    }),

    test('19. QualityCheckerAgent - C语言安全检测', async () => {
      const { default: QualityCheckerAgent } = await import('../src/agents/QualityCheckerAgent.js');
      
      const mockProvider = {
        chat: async () => ({ content: '{}', role: 'assistant' })
      };

      const checker = new QualityCheckerAgent(mockProvider);
      
      const cCodeWithIssues = `
        #include <stdio.h>
        int main() {
          char buf[100];
          gets(buf);
          strcpy(buf, "hello");
          char *p = malloc(100);
          return 0;
        }
      `;

      const result = checker._checkCSecurity(cCodeWithIssues);
      
      const hasGets = result.some(i => i.includes('gets()'));
      const hasStrcpy = result.some(i => i.includes('strcpy()'));
      const hasMalloc = result.some(i => i.includes('内存泄漏'));

      if (!hasGets) throw new Error('未检测到 gets() 危险函数');
      if (!hasStrcpy) throw new Error('未检测到 strcpy() 危险函数');
      if (!hasMalloc) throw new Error('未检测到内存泄漏风险');
    }),

    test('20. QualityCheckerAgent - 代码指标计算', async () => {
      const { default: QualityCheckerAgent } = await import('../src/agents/QualityCheckerAgent.js');
      
      const mockProvider = {
        chat: async () => ({ content: '{}', role: 'assistant' })
      };

      const checker = new QualityCheckerAgent(mockProvider);
      
      const testCode = `
        // 这是注释
        #include <stdio.h>
        
        /* 块注释 */
        int main() {
          printf("hello");
          return 0;
        }
        
        void helper() {
        }
      `;

      const metrics = checker._calculateMetrics(testCode);
      
      if (metrics.linesOfCode <= 0) throw new Error('行数计算错误');
      if (metrics.functionCount < 2) throw new Error('函数数计算错误');
      if (metrics.commentLines < 2) throw new Error('注释行计算错误');
    }),

    test('21. ExperimentReportGenerator - 基本功能', async () => {
      const { default: ExperimentReportGenerator } = await import('../src/utils/ExperimentReportGenerator.js');
      
      const testReportDir = path.join(TEST_DIR, 'reports');
      const generator = new ExperimentReportGenerator({
        reportDir: testReportDir,
        maxReports: 10
      });

      if (generator.reportDir !== testReportDir) {
        throw new Error('reportDir 不正确');
      }

      if (typeof generator.generateReport !== 'function') {
        throw new Error('generateReport 方法不存在');
      }

      if (typeof generator.listReports !== 'function') {
        throw new Error('listReports 方法不存在');
      }
    }),

    test('22. ExperimentReportGenerator - 报告生成和保存', async () => {
      const { default: ExperimentReportGenerator } = await import('../src/utils/ExperimentReportGenerator.js');
      
      const testReportDir = path.join(TEST_DIR, 'reports2');
      const generator = new ExperimentReportGenerator({
        reportDir: testReportDir,
        maxReports: 10
      });

      const taskSummary = {
        originalTask: '用C语言写一个贪吃蛇游戏',
        successRate: 100,
        totalTasks: 5,
        completedTasks: 5,
        failedTasks: 0,
        outputDir: './workspace/test',
        constraints: {
          language: 'C语言',
          techStack: '控制台',
          platform: 'Windows'
        },
        tasks: [
          { id: 'T1', title: '主程序框架', status: 'completed', qualityScore: 90 },
          { id: 'T2', title: '游戏逻辑', status: 'completed', qualityScore: 85 }
        ]
      };

      const { report, filePath } = generator.generateAndSave(taskSummary);

      if (!report.id) throw new Error('报告ID未生成');
      if (!report.content) throw new Error('报告内容未生成');
      if (!fs.existsSync(filePath)) throw new Error('报告文件未保存');
      if (!report.metadata.tags || report.metadata.tags.length === 0) {
        throw new Error('报告标签未生成');
      }
    }),

    test('23. ExperimentReportGenerator - 报告列表和搜索', async () => {
      const { default: ExperimentReportGenerator } = await import('../src/utils/ExperimentReportGenerator.js');
      
      const testReportDir = path.join(TEST_DIR, 'reports3');
      const generator = new ExperimentReportGenerator({
        reportDir: testReportDir,
        maxReports: 10
      });

      for (let i = 0; i < 3; i++) {
        generator.generateAndSave({
          originalTask: `测试任务 ${i} - C语言 贪吃蛇游戏`,
          successRate: 80 + i * 5,
          totalTasks: 3,
          completedTasks: 2 + i,
          failedTasks: 1 - i > 0 ? 1 - i : 0,
          outputDir: './workspace/test',
          constraints: { language: 'C语言' },
          tasks: []
        });
      }

      const reports = generator.listReports();
      if (reports.length < 3) {
        throw new Error(`报告列表数量应至少为3，实际为${reports.length}`);
      }

      const searchResults = generator.searchReports('贪吃蛇');
      if (searchResults.length === 0) {
        throw new Error('搜索功能不工作');
      }

      const tags = generator.getTags();
      if (!Array.isArray(tags) || tags.length === 0) {
        throw new Error('标签获取失败');
      }
    }),

    test('24. ExperimentReportGenerator - 智能上下文检索', async () => {
      const { default: ExperimentReportGenerator } = await import('../src/utils/ExperimentReportGenerator.js');
      
      const testReportDir = path.join(TEST_DIR, 'reports4');
      const generator = new ExperimentReportGenerator({
        reportDir: testReportDir,
        maxReports: 10
      });

      generator.generateAndSave({
        originalTask: '用C语言写一个贪吃蛇游戏',
        successRate: 100,
        totalTasks: 5,
        completedTasks: 5,
        failedTasks: 0,
        outputDir: './workspace/test',
        constraints: { language: 'C语言' },
        tasks: []
      });

      const context = generator.getContextForNewTask('C语言贪吃蛇', { count: 1 });
      
      if (!context || context === '无历史报告') {
        throw new Error('智能上下文检索失败');
      }

      if (!context.includes('C语言')) {
        throw new Error('上下文检索结果不包含相关信息');
      }
    }),

    test('26. MergeEngine - 模块创建和基本功能', async () => {
      const MergeEngine = require('../src/agents/MergeEngine');
      const ProviderFactory = require('../src/providers');
      const provider = ProviderFactory.create('ollama');
      const engine = new MergeEngine(provider);
      
      if (!engine.name || engine.name !== 'MergeEngine') {
        throw new Error('MergeEngine 名称不正确');
      }
      if (!engine.merge) {
        throw new Error('MergeEngine 缺少 merge 方法');
      }
      if (!engine._groupByFile) {
        throw new Error('MergeEngine 缺少 _groupByFile 方法');
      }
    }),

    test('27. MergeEngine - 空结果合并', async () => {
      const MergeEngine = require('../src/agents/MergeEngine');
      const ProviderFactory = require('../src/providers');
      const provider = ProviderFactory.create('ollama');
      const engine = new MergeEngine(provider);
      
      const result = await engine.merge({}, {});
      if (!result.error) {
        throw new Error('空结果合并应返回错误');
      }
    }),

    test('28. MultiAgentDispatcher - 包含 merge / privacy / quality 模式', async () => {
      const MultiAgentDispatcher = require('../src/core/MultiAgentDispatcher');
      const dispatcher = new MultiAgentDispatcher();
      
      const modes = dispatcher.getModes();
      const modeNames = modes.map(m => m.name);
      
      if (!modeNames.includes('merge')) {
        throw new Error('MultiAgentDispatcher 缺少 merge 模式');
      }
      if (!modeNames.includes('privacy')) {
        throw new Error('MultiAgentDispatcher 缺少 privacy 模式');
      }
      if (!modeNames.includes('quality')) {
        throw new Error('MultiAgentDispatcher 缺少 quality 模式');
      }
      if (modeNames.length !== 7) {
        throw new Error(`模式数量应为7，实际为${modeNames.length}`);
      }
    }),

    test('29. TaskSplitterAgent - 复杂度分析', async () => {
      const TaskSplitterAgent = require('../src/agents/TaskSplitterAgent');
      const ProviderFactory = require('../src/providers');
      const provider = ProviderFactory.create('ollama');
      const splitter = new TaskSplitterAgent(provider);
      
      const complexity = splitter._analyzeComplexity('用C++实现一个支持多线程的HTTP服务器，包含路由、中间件、日志模块');
      
      if (!complexity.level || complexity.level !== 'high') {
        throw new Error(`高复杂度任务应返回 high，实际为 ${complexity.level}`);
      }
      if (!complexity.languages.includes('C++')) {
        throw new Error('复杂度分析应检测出 C++ 语言');
      }
      if (complexity.keywordCount < 5) {
        throw new Error('高复杂度任务关键词数应 >= 5');
      }
    }),

    test('30. TaskSplitterAgent - 依赖验证和循环检测', async () => {
      const TaskSplitterAgent = require('../src/agents/TaskSplitterAgent');
      const ProviderFactory = require('../src/providers');
      const provider = ProviderFactory.create('ollama');
      const splitter = new TaskSplitterAgent(provider);
      
      // 无循环依赖
      const validDeps = [
        { id: 'T1', dependsOn: [] },
        { id: 'T2', dependsOn: ['T1'] },
        { id: 'T3', dependsOn: ['T2'] }
      ];
      const check1 = splitter._validateDependencies(validDeps);
      if (!check1.valid) {
        throw new Error('无循环依赖应返回 valid');
      }
      
      // 有循环依赖
      const invalidDeps = [
        { id: 'T1', dependsOn: ['T3'] },
        { id: 'T2', dependsOn: ['T1'] },
        { id: 'T3', dependsOn: ['T2'] }
      ];
      const check2 = splitter._validateDependencies(invalidDeps);
      if (check2.valid) {
        throw new Error('循环依赖应返回 invalid');
      }
      if (check2.cycles.length === 0) {
        throw new Error('应检测到循环依赖');
      }
    }),

    test('31. QualityCheckerAgent - 工具链检测', async () => {
      const QualityCheckerAgent = require('../src/agents/QualityCheckerAgent');
      const ProviderFactory = require('../src/providers');
      const provider = ProviderFactory.create('ollama');
      const checker = new QualityCheckerAgent(provider);
      
      if (!checker.toolRunner) {
        throw new Error('QualityCheckerAgent 缺少 toolRunner');
      }
      
      // 检测工具可用性（不依赖实际安装）
      const hasNode = checker.toolRunner.hasTool('node');
      const hasPython = checker.toolRunner.hasTool('python') || checker.toolRunner.hasTool('python3');
      
      console.log(`   检测到 Node: ${hasNode}, Python: ${hasPython}`);
      
      // 测试代码指标计算
      const code = 'int main() {\n  // hello\n  printf("hello");\n  return 0;\n}';
      const metrics = checker._calculateMetrics(code);
      if (metrics.linesOfCode !== 5) {
        throw new Error(`代码行数应为5，实际为${metrics.linesOfCode}`);
      }
      if (metrics.functionCount !== 1) {
        throw new Error(`函数数应为1，实际为${metrics.functionCount}`);
      }
    })
  ];

  for (const testFn of tests) {
    await testFn();
  }

  console.log('');
  console.log('='.repeat(50));
}

async function main() {
  await runTests();

  const passed = results.tests.filter(t => t.status === 'PASS').length;
  const failed = results.tests.filter(t => t.status === 'FAIL').length;
  const total = results.tests.length;

  results.summary = {
    passed,
    failed,
    total,
    successRate: total > 0 ? Math.round((passed / total) * 100) : 0
  };

  console.log(`\n📊 测试结果: ${passed}/${total} 通过 (${results.summary.successRate}%)`);

  if (failed > 0) {
    console.log('\n❌ 失败的测试:');
    results.tests.filter(t => t.status === 'FAIL').forEach(t => {
      console.log(`   - ${t.name}: ${t.error}`);
    });
  }

  const reportDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const reportFile = path.join(reportDir, `smoke_test_${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(results, null, 2));
  console.log(`\n📝 测试报告已保存: ${reportFile}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
