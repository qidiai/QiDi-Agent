#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const path = require('path');
const { safeJsonParse } = require('../utils/SafeParser');

const ProviderFactory = require('../providers');
const TaskOrchestrator = require('../core/TaskOrchestrator');
const MultiAgentDispatcher = require('../core/MultiAgentDispatcher');
const ToolScanner = require('../core/ToolScanner');
const AdapterFactory = require('../adapters');
const FileManager = require('../utils/FileManager');
const { logo, miniLogo, banner, printLogo } = require('./logo');
const { VersionManager } = require('../utils/VersionManager');
const Logger = require('../utils/Logger').Logger;
const packageJson = require('../../package.json');

const program = new Command();

program
  .name('qidi')
  .description('启迪 Agent - 多 AI 编程工具统一编排与协作平台')
  .version(packageJson.version);

program
  .command('run')
  .description('运行一个代码任务')
  .option('-t, --task <task>', '任务描述')
  .option('-m, --mode <mode>', '执行模式: privacy|quality|multi', 'privacy')
  .option('-p, --provider <provider>', '模型提供商: ollama|openai', process.env.MODEL_PROVIDER || 'ollama')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .option('-v, --verbose', '显示详细日志')
  .action(async (options) => {
    printLogo();

    let taskDescription = options.task;

    if (!taskDescription) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'task',
          message: '请输入你的代码任务：',
          validate: (input) => input.length > 0 ? true : '任务描述不能为空'
        }
      ]);
      taskDescription = answers.task;
    }

    // 显示执行模式
    const modeDisplay = options.mode === 'privacy'
      ? '🔒 隐私模式'
      : options.mode === 'multi'
        ? '🔀 多模型并行模式'
        : '✨ 高质量模式';
    console.log(chalk.cyan(`执行模式: ${modeDisplay}`));

    let provider;
    try {
      provider = ProviderFactory.create(options.provider);
    } catch (e) {
      console.log(chalk.red(`❌ 错误: ${e.message}`));
      process.exit(1);
    }

    console.log(chalk.gray(`模型提供商: ${provider.name}`));
    console.log(chalk.gray(`工作目录: ${path.resolve(options.workspace)}\n`));

    const connectSpinner = ora('正在连接 AI 模型...').start();
    try {
      const connected = await provider.checkConnection();
      if (!connected) {
        connectSpinner.fail('无法连接到 AI 模型');
        console.log(chalk.yellow('\n💡 提示:'));
        console.log(chalk.yellow('   - 确保 Ollama 正在运行: ollama serve'));
        console.log(chalk.yellow('   - 确保已安装模型: ollama pull qwen2.5:7b'));
        console.log(chalk.yellow('   - 或配置 OpenAI API Key'));
        process.exit(1);
      }
      connectSpinner.succeed('AI 模型连接成功');
    } catch (e) {
      connectSpinner.fail(`连接失败: ${e.message}`);
      process.exit(1);
    }

    // ===== 自动检测并连接本机 AI 编程工具 =====
    let registeredTools = [];
    try {
      console.log(chalk.gray('\n🔍 正在检测本机 AI 编程工具...'));
      const scanner = new ToolScanner();
      scanner.registerAdapters(AdapterFactory.createAll());
      await scanner.scan();
      await scanner.connectAll();
      registeredTools = Array.from(scanner.registeredTools.values());
      if (registeredTools.length > 0) {
        console.log(chalk.green(`✅ 已接入 ${registeredTools.length} 个 AI 编程工具:`));
        for (const tool of registeredTools) {
          console.log(chalk.gray(`   - ${tool.displayName}`));
        }
      } else {
        console.log(chalk.yellow('⚠️  未发现可用的 AI 编程工具，仅使用 Provider'));
      }
    } catch (scanErr) {
      console.log(chalk.yellow(`⚠️  工具扫描失败: ${scanErr.message}，仅使用 Provider`));
    }

    // ===== multi 模式:加载所有已启用的 Provider =====
    let extraProviders = [];
    if (options.mode === 'multi') {
      try {
        const AgentHub = require('../core/AgentHub');
        const hub = new AgentHub({ configDir: path.join(__dirname, '../../config') });
        await hub.initialize();
        const enabled = hub.getEnabledAgents();
        extraProviders = enabled
          .map(a => ({ name: a.name, provider: a.provider }))
          .filter(p => p.provider);
        console.log(chalk.cyan(`🔀 多模型模式: 已加载 ${extraProviders.length} 个 Provider`));
        extraProviders.forEach(p => console.log(chalk.gray(`   - ${p.name}`)));
      } catch (e) {
        console.log(chalk.yellow(`⚠️  多 Provider 加载失败: ${e.message},退化为单 Provider`));
      }
    }

    const orchestrator = new TaskOrchestrator(provider, {
      workspaceDir: options.workspace,
      verbose: options.verbose,
      toolAdapters: registeredTools,
      executionMode: options.mode,
      providers: extraProviders.length > 0 ? extraProviders.map(p => p.provider) : undefined
    });

    // 设置执行模式
    orchestrator.setExecutionMode(options.mode);

    setupEventListeners(orchestrator, options.verbose);

    console.log('');
    const mainSpinner = ora('开始处理任务...').start();

    try {
      await orchestrator.initialize();
      const result = await orchestrator.runTask(taskDescription);
      mainSpinner.succeed('任务处理完成！\n');

      printSummary(result);
    } catch (e) {
      mainSpinner.fail(`任务失败: ${e.message}`);
      if (options.verbose) {
        console.error(e);
      }
      process.exit(1);
    }
  });

program
  .command('check')
  .description('检查 AI 模型连接状态')
  .option('-p, --provider <provider>', '模型提供商: ollama|openai', process.env.MODEL_PROVIDER || 'ollama')
  .action(async (options) => {
    console.log(chalk.bold.cyan('\n🔍 检查 AI 模型连接\n'));

    try {
      const provider = ProviderFactory.create(options.provider);
      console.log(chalk.gray(`提供商: ${provider.name}`));

      const spinner = ora('正在测试连接...').start();
      const connected = await provider.checkConnection();

      if (connected) {
        spinner.succeed('连接成功！');
      } else {
        spinner.fail('连接失败');
      }

      if (provider.listModels) {
        const modelsSpinner = ora('获取模型列表...').start();
        const models = await provider.listModels();
        if (models.length > 0) {
          modelsSpinner.succeed(`找到 ${models.length} 个模型:`);
          models.forEach(m => {
            console.log(chalk.gray(`   - ${m.name || m.id}`));
          });
        } else {
          modelsSpinner.info('未找到模型');
        }
      }
    } catch (e) {
      console.log(chalk.red(`\n❌ 错误: ${e.message}`));
      process.exit(1);
    }

    console.log('');
  });

program
  .command('list')
  .description('列出工作目录中的文件')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .option('-d, --depth <n>', '显示深度', '3')
  .action((options) => {
    const fileManager = new FileManager(options.workspace);
    const tree = fileManager.getFileTree('.', parseInt(options.depth));
    console.log(chalk.bold.cyan('\n📁 工作目录结构:\n'));
    console.log(tree || chalk.gray('   (空目录)'));
    console.log('');
  });

program
  .command('reports')
  .description('列出所有实验报告')
  .option('-c, --count <n>', '显示数量', '10')
  .action((options) => {
    const orchestrator = new TaskOrchestrator(null, {});
    const reports = orchestrator.listReports();

    console.log(chalk.bold.cyan('\n📋 实验报告列表:\n'));

    if (reports.length === 0) {
      console.log(chalk.gray('   (暂无报告)'));
    } else {
      reports.slice(0, parseInt(options.count)).forEach((report, i) => {
        const statusIcon = report.successRate === 100 ? '✅' : report.successRate >= 70 ? '⚠️' : '❌';
        console.log(`  ${i + 1}. ${statusIcon} ${chalk.cyan(report.id)}`);
        console.log(`     ${chalk.gray(report.date)}`);
        console.log(`     任务: ${report.task}`);
        console.log(`     成功率: ${report.successRate}% (${report.totalTasks}个任务)`);
        if (report.keywords && report.keywords.length > 0) {
          console.log(`     关键词: ${report.keywords.join(', ')}`);
        }
        console.log('');
      });
    }
    console.log('');
  });

program
  .command('report')
  .description('查看指定报告')
  .argument('<id>', '报告ID')
  .action((id) => {
    const orchestrator = new TaskOrchestrator(null, {});
    const report = orchestrator.loadReport(id);

    if (!report) {
      console.log(chalk.red(`\n❌ 报告 ${id} 不存在\n`));
      process.exit(1);
    }

    console.log(chalk.bold.cyan('\n'));
    console.log(report.content);
  });

program
  .command('context')
  .description('查看历史上下文')
  .option('-c, --count <n>', '显示最近报告数量', '3')
  .action((options) => {
    const orchestrator = new TaskOrchestrator(null, {});
    const context = orchestrator.getHistoricalContext(parseInt(options.count));

    console.log(chalk.bold.cyan('\n📚 历史上下文:\n'));
    console.log(context);
    console.log('');
  });

function setupEventListeners (orchestrator, verbose) {
  orchestrator.on('splitting', () => {
    ora().info('📋 正在分析并拆分任务...');
  });

  orchestrator.on('taskSplit', (data) => {
    console.log(chalk.green('\n✅ 任务拆分完成!'));
    console.log(chalk.gray(`\n📝 概述: ${data.overview}`));
    console.log(chalk.gray(`\n📋 共 ${data.tasks.length} 个子任务:\n`));

    data.tasks.forEach((task, i) => {
      const icon = getRoleIcon(task.role);
      const complexity = getComplexityColor(task.estimatedComplexity);
      console.log(`  ${chalk.cyan(task.id)} ${icon} ${task.title}`);
      console.log(`     ${chalk.gray(task.description.substring(0, 60))}...`);
      console.log(`     角色: ${chalk.yellow(task.role)} | 复杂度: ${complexity}`);
      if (task.dependsOn && task.dependsOn.length > 0) {
        console.log(`     依赖: ${task.dependsOn.join(', ')}`);
      }
      console.log('');
    });

    console.log(chalk.blue('📊 执行计划: ') + data.plan + '\n');
  });

  orchestrator.on('taskStart_sub', (data) => {
    console.log(chalk.cyan(`\n[${data.index + 1}/${data.total}] 开始任务: ${data.task.title}`));
  });

  orchestrator.on('agentWorking', (data) => {
    if (verbose) {
      console.log(chalk.gray(`   👤 ${data.agent} 正在工作...`));
    }
  });

  orchestrator.on('qualityReview', (data) => {
    if (verbose) {
      console.log(chalk.yellow(`   🔍 质量评分: ${data.quality.qualityScore}/100`));
      if (data.needsRevision) {
        console.log(chalk.yellow('   ⚠️ 需要返工'));
      }
    }
  });

  orchestrator.on('taskComplete_sub', (data) => {
    const score = data.result?.quality?.qualityScore || '?';
    console.log(chalk.green(`   ✅ 完成 (质量: ${score}/100)`));
  });

  orchestrator.on('taskFailed', (data) => {
    console.log(chalk.red(`   ❌ 失败: ${data.error}`));
  });

  orchestrator.on('multiToolDispatch', (data) => {
    if (data.tools && data.tools.length > 0) {
      console.log(chalk.blue(`   🚀 并行派发到 ${data.tools.length} 个工具: ${data.tools.map(t => t.displayName).join(', ')}`));
    }
  });

  orchestrator.on('toolFailed', (data) => {
    if (verbose) {
      console.log(chalk.red(`   ⚠️ ${data.tool} 执行失败: ${data.error}`));
    }
  });

  orchestrator.on('multiToolMerged', (data) => {
    if (data.toolsUsed && data.toolsUsed.length > 0) {
      console.log(chalk.magenta(`   🧩 合并了 ${data.toolsUsed.length} 个工具产出，冲突 ${data.conflicts} 个`));
      if (data.quality) {
        const q = data.quality;
        console.log(chalk.gray(`     质量: 正确性${q.correctness} 一致性${q.consistency} 可读性${q.readability}`));
      }
    }
  });

  orchestrator.on('mergeFailed', (data) => {
    console.log(chalk.yellow(`   ⚠️ 合并失败: ${data.error}，已回落选择最优结果`));
  });

  orchestrator.on('multiToolCompare', (data) => {
    if (data && data.length > 1) {
      const lines = data.filter(d => d.success).map(d => `     ${chalk.cyan(d.tool.padEnd(12))} ${d.blocks} 个代码块`);
      if (lines.length > 0) {
        console.log(chalk.gray('   📊 工具产出对比:'));
        lines.forEach(l => console.log(l));
      }
    }
  });

  orchestrator.on('taskRetry', (data) => {
    console.log(chalk.yellow(`   🔄 重试 (第 ${data.attempt} 次): ${data.error}`));
  });

  orchestrator.on('reportGenerated', (data) => {
    console.log(chalk.blue(`\n📋 实验报告已生成: ${data.reportId}`));
  });
}

function printSummary (result) {
  console.log(chalk.bold.cyan('═══════════════════════════════════════════'));
  console.log(chalk.bold.cyan('           📊 任务执行总结'));
  console.log(chalk.bold.cyan('═══════════════════════════════════════════\n'));

  console.log(`  ${chalk.bold('成功率:')} ${result.successRate}% (${result.completedTasks}/${result.totalTasks})`);
  console.log(`  ${chalk.bold('输出目录:')} ${result.outputDir}\n`);

  if (result.reportId) {
    console.log(`  ${chalk.bold('📋 实验报告:')} ${chalk.cyan(result.reportId)}`);
    console.log(`  ${chalk.gray('   查看报告: aio report ' + result.reportId)}`);
    console.log(`  ${chalk.gray('   查看历史: aio context')}\n`);
  }

  console.log(chalk.bold('  任务详情:\n'));
  result.tasks.forEach(task => {
    const statusIcon = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏳';
    const scoreText = task.qualityScore ? ` [${task.qualityScore}分]` : '';
    console.log(`  ${statusIcon} ${chalk.cyan(task.id)} ${task.title}${scoreText}`);
  });

  console.log('');

  if (result.successRate === 100) {
    console.log(chalk.green.bold('  🎉 所有任务完成！\n'));
  } else if (result.successRate >= 70) {
    console.log(chalk.yellow.bold('  ⚠️  部分任务失败，请检查详情\n'));
  } else {
    console.log(chalk.red.bold('  ❌ 多数任务失败，建议重试\n'));
  }
}

program
  .command('multi')
  .description('同时分派任务给多个 AI Agent')
  .option('-t, --task <task>', '任务描述')
  .option('-a, --agents <agents>', '指定 Agent 列表，用逗号分隔', '')
  .option('-m, --mode <mode>', '分派模式: parallel|sequential|select|privacy|quality', 'parallel')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .option('-v, --verbose', '显示详细日志')
  .action(async (options) => {
    printLogo({ banner: true });

    let taskDescription = options.task;

    if (!taskDescription) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'task',
          message: '请输入你的代码任务：',
          validate: (input) => input.length > 0 ? true : '任务描述不能为空'
        }
      ]);
      taskDescription = answers.task;
    }

    const dispatcher = new MultiAgentDispatcher({
      configDir: path.join(__dirname, '../../config'),
      workspaceDir: options.workspace,
      mode: options.mode
    });

    const spinner = ora('正在初始化 Agent Hub...').start();
    try {
      await dispatcher.initialize();
      spinner.succeed('Agent Hub 初始化成功');
    } catch (e) {
      spinner.fail(`初始化失败: ${e.message}`);
      process.exit(1);
    }

    const agents = options.agents ? options.agents.split(',').map(a => a.trim()) : [];

    console.log(chalk.bold('\n📋 可用的 Agent:\n'));
    const allAgents = await dispatcher.listAgents();
    for (const agent of allAgents) {
      const statusIcon = agent.enabled ? '✅' : '❌';
      const statusColor = agent.enabled ? chalk.green : chalk.red;
      console.log(`  ${statusIcon} ${chalk.cyan(agent.name_display)} - ${agent.description}`);
      console.log(`     提供商: ${agent.provider} | 状态: ${statusColor(agent.status)}`);
    }
    console.log('');

    const availableAgents = allAgents.filter(a => a.enabled).map(a => a.name);
    const targetAgents = agents.filter(a => availableAgents.includes(a));

    if (targetAgents.length === 0) {
      console.log(chalk.yellow('⚠️  未指定有效 Agent 或没有可用的 Agent'));
      console.log(chalk.gray(`   可用 Agent: ${availableAgents.join(', ')}`));
      console.log(chalk.gray('   使用 -a 参数指定，如: -a ollama,deepseek\n'));

      const { selectedAgents } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'selectedAgents',
          message: '选择要使用的 Agent（可多选）：',
          choices: availableAgents.map(name => {
            const agent = allAgents.find(a => a.name === name);
            return {
              name: `${agent.name_display} - ${agent.description}`,
              value: name,
              checked: name === availableAgents[0]
            };
          })
        }
      ]);
      targetAgents.push(...selectedAgents);
    }

    if (targetAgents.length === 0) {
      console.log(chalk.red('❌ 没有选择任何 Agent'));
      process.exit(1);
    }

    console.log(chalk.bold('\n🎯 目标 Agent: ') + targetAgents.join(', '));
    console.log(chalk.gray(`   模式: ${options.mode}\n`));

    const resultSpinner = ora('正在分派任务...').start();

    try {
      const result = await dispatcher.dispatch(taskDescription, {
        agents: targetAgents,
        mode: options.mode,
        workspaceDir: options.workspace,
        verbose: options.verbose
      });

      resultSpinner.succeed('任务分派完成！');

      console.log('\n');
      console.log(chalk.bold.cyan('═══════════════════════════════════════════'));
      console.log(chalk.bold.cyan('         📊 多 Agent 分派总结'));
      console.log(chalk.bold.cyan('═══════════════════════════════════════════\n'));

      if (result.summary) {
        console.log(`  ${chalk.bold('总 Agent 数:')} ${result.summary.total}`);
        console.log(`  ${chalk.bold('成功:')} ${chalk.green(result.summary.successful)}`);
        console.log(`  ${chalk.bold('失败:')} ${chalk.red(result.summary.failed)}`);
        console.log(`  ${chalk.bold('成功率:')} ${result.summary.successRate}%\n`);
      }

      console.log(chalk.bold('  各 Agent 结果:\n'));
      for (const [agentName, agentResult] of Object.entries(result.results || {})) {
        const agent = allAgents.find(a => a.name === agentName);
        const statusIcon = agentResult.success ? '✅' : '❌';
        const statusText = agentResult.success ? chalk.green('成功') : chalk.red('失败');

        console.log(`  ${statusIcon} ${chalk.cyan(agent?.name_display || agentName)}: ${statusText}`);

        if (agentResult.reportId) {
          console.log(`     📋 报告: ${chalk.gray(agentResult.reportId)}`);
        }

        if (options.verbose && agentResult.result) {
          const successRate = agentResult.result.successRate || 0;
          console.log(`     📊 成功率: ${successRate}%`);
          console.log(`     📁 输出: ${agentResult.outputDir || agentResult.result?.outputDir}`);
        }
        console.log('');
      }

      if (result.best) {
        console.log(chalk.green.bold('  🏆 最佳结果: ') + `${result.best.agent} (质量: ${result.best.qualityScore}分)`);
        console.log(`     📋 报告: ${chalk.gray(result.best.result?.reportId || result.best.reportId)}`);
        console.log('');
      }

      console.log(chalk.blue('💡 查看详细报告: aio reports\n'));
    } catch (e) {
      resultSpinner.fail(`分派失败: ${e.message}`);
      if (options.verbose) {
        console.error(e);
      }
      process.exit(1);
    }
  });

program
  .command('agents')
  .description('查看和管理 Agent')
  .option('-l, --list', '列出所有 Agent')
  .option('-e, --enable <name>', '启用 Agent')
  .option('-d, --disable <name>', '禁用 Agent')
  .option('-c, --check', '检查所有 Agent 连接状态')
  .action(async (options) => {
    const dispatcher = new MultiAgentDispatcher({
      configDir: path.join(__dirname, '../../config')
    });

    await dispatcher.initialize();

    if (options.check) {
      console.log(chalk.bold.cyan('\n🔍 检查 Agent 连接状态...\n'));

      const results = await dispatcher.checkAgents();

      for (const [name, result] of Object.entries(results)) {
        const statusIcon = result.status === 'online' ? '✅' : result.status === 'offline' ? '⚠️' : '❌';
        const statusText = result.status === 'online'
          ? chalk.green('在线')
          : result.status === 'offline'
            ? chalk.yellow('离线')
            : chalk.red('错误');

        console.log(`  ${statusIcon} ${chalk.cyan(name)}: ${statusText}`);
        if (result.message) {
          console.log(`     ${chalk.gray(result.message)}`);
        }
      }
      console.log('');
      return;
    }

    if (options.enable) {
      const success = await dispatcher.enableAgent(options.enable);
      if (success) {
        console.log(chalk.green(`\n✅ Agent '${options.enable}' 已启用\n`));
      } else {
        console.log(chalk.red(`\n❌ 启用 Agent '${options.enable}' 失败\n`));
      }
      return;
    }

    if (options.disable) {
      const success = await dispatcher.disableAgent(options.disable);
      if (success) {
        console.log(chalk.yellow(`\n⚠️  Agent '${options.disable}' 已禁用\n`));
      } else {
        console.log(chalk.red(`\n❌ 禁用 Agent '${options.disable}' 失败\n`));
      }
      return;
    }

    console.log(chalk.bold.cyan('\n📋 Agent 列表:\n'));
    const agents = await dispatcher.listAgents();

    for (const agent of agents) {
      const statusIcon = agent.enabled ? '✅' : '❌';
      const statusColor = agent.enabled ? chalk.green : chalk.red;

      console.log(`  ${statusIcon} ${chalk.cyan(agent.name_display || agent.name)}`);
      console.log(`     ${chalk.gray(agent.description)}`);
      console.log(`     提供商: ${agent.provider} | 状态: ${statusColor(agent.status)}`);
      console.log('');
    }
  });

function getRoleIcon (role) {
  const icons = {
    code_writer: '💻',
    code_reviewer: '🔍',
    tester: '🧪',
    architect: '🏗️'
  };
  return icons[role] || '📋';
}

function getComplexityColor (complexity) {
  const colors = {
    low: chalk.green('低'),
    medium: chalk.yellow('中'),
    high: chalk.red('高')
  };
  return colors[complexity] || chalk.gray(complexity || '未知');
}

program
  .command('scan')
  .description('自动扫描本机已安装的 AI 编程工具')
  .option('-s, --save', '保存扫描结果到配置文件')
  .option('-c, --connect', '扫描后自动连接')
  .action(async (options) => {
    printLogo({ mini: true });
    console.log(chalk.bold.cyan('🔍 AI 工具扫描器\n'));

    const scanner = new ToolScanner();
    scanner.registerAdapters(AdapterFactory.createAll());

    await scanner.scan();

    const report = scanner.getScanReport();
    console.log(report);

    if (options.save) {
      const filePath = scanner.saveResults();
      console.log(chalk.green(`\n✅ 扫描结果已保存到: ${filePath}`));
    }

    if (options.connect) {
      console.log(chalk.blue('\n🔗 正在自动连接已发现的工具...\n'));
      await scanner.connectAll();

      const registered = scanner.getRegisteredTools();
      if (registered.length > 0) {
        console.log(chalk.green(`\n✅ 已注册 ${registered.length} 个工具:`));
        for (const tool of registered) {
          console.log(`   - ${tool.displayName}`);
        }
      } else {
        console.log(chalk.yellow('\n⚠️  没有工具可以连接'));
      }
    }
  });

program
  .command('connect')
  .description('连接 AI 编程工具')
  .option('-a, --auto', '自动接入所有已发现的工具')
  .option('-t, --tool <name>', '连接指定工具')
  .option('-s, --scan', '先扫描再连接')
  .action(async (options) => {
    printLogo({ mini: true });
    console.log(chalk.bold.cyan('🔗 AI 工具连接\n'));

    const scanner = new ToolScanner();
    scanner.registerAdapters(AdapterFactory.createAll());

    if (options.scan || !options.tool) {
      await scanner.scan();
    }

    if (options.auto) {
      console.log('🚀 自动接入所有已发现的工具...\n');
      await scanner.connectAll();

      const registered = scanner.getRegisteredTools();
      console.log(chalk.bold.cyan('\n═══════════════════════════════════════════'));
      console.log(chalk.bold.cyan('           📊 连接结果'));
      console.log(chalk.bold.cyan('═══════════════════════════════════════════\n'));

      if (registered.length > 0) {
        console.log(chalk.green(`✅ 成功接入 ${registered.length} 个工具:\n`));
        for (const tool of registered) {
          console.log(`   🎯 ${tool.displayName}`);
          console.log(`      状态: ${chalk.green(tool.status)}`);
          if (tool.version) {
            console.log(`      版本: ${tool.version}`);
          }
          if (tool.installPath) {
            console.log(`      路径: ${chalk.gray(tool.installPath)}`);
          }
          console.log('');
        }
        console.log(chalk.blue('💡 使用命令: aio multi -t "你的任务" 来分派任务\n'));
      } else {
        console.log(chalk.yellow('⚠️  没有工具成功接入'));
        console.log(chalk.gray('   请检查工具是否已正确安装\n'));
      }
    } else if (options.tool) {
      try {
        const result = await scanner.connect(options.tool);

        if (result.success) {
          console.log(chalk.green(`\n✅ ${result.displayName || options.tool} 连接成功\n`));
        } else {
          console.log(chalk.red(`\n❌ 连接失败: ${result.message}\n`));
        }
      } catch (e) {
        console.log(chalk.red(`\n❌ 错误: ${e.message}\n`));
      }
    } else {
      const available = scanner.getAvailableTools();

      if (available.length === 0) {
        console.log(chalk.yellow('⚠️  没有发现可用的工具'));
        console.log(chalk.gray('   先运行: aio scan\n'));
        return;
      }

      const { selectedTools } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'selectedTools',
          message: '选择要连接的工具（可多选）：',
          choices: available.map(t => ({
            name: `${t.displayName}${t.version ? ` (${t.version})` : ''}`,
            value: t.name,
            checked: true
          }))
        }
      ]);

      console.log('\n');
      for (const toolName of selectedTools) {
        try {
          const result = await scanner.connect(toolName);
          if (result.success) {
            console.log(chalk.green(`✅ ${result.displayName || toolName} 连接成功`));
          } else {
            console.log(chalk.red(`❌ ${result.displayName || toolName} 连接失败: ${result.message}`));
          }
        } catch (e) {
          console.log(chalk.red(`❌ ${toolName} 连接失败: ${e.message}`));
        }
      }

      console.log('\n');
    }

    scanner.saveResults();
  });

program
  .command('health')
  .description('检查 AI 工具健康状态')
  .option('-t, --tool <name>', '检查指定工具')
  .option('-l, --list', '列出所有工具状态')
  .option('-r, --report', '生成健康报告')
  .action(async (options) => {
    printLogo({ mini: true });
    console.log(chalk.bold.cyan('🔍 AI 工具健康检查\n'));

    const ToolHealthChecker = require('../core/ToolHealthChecker');
    const healthChecker = new ToolHealthChecker({ timeout: 5000 });
    healthChecker.registerAdapters(AdapterFactory.createAll());

    if (options.tool) {
      const adapter = AdapterFactory.createAll().find(a => a.name === options.tool || a.displayName === options.tool);
      if (!adapter) {
        console.log(chalk.red(`❌ 未找到工具: ${options.tool}\n`));
        process.exit(1);
      }

      const result = await healthChecker.check(adapter);
      const statusIcon = result.status === 'healthy' ? '✅' : '❌';
      const statusColor = result.status === 'healthy' ? chalk.green : chalk.red;

      console.log(`  ${statusIcon} ${chalk.cyan(result.displayName)}: ${statusColor(result.status)}`);
      if (result.responseTime) {
        console.log(`     响应时间: ${chalk.gray(`${result.responseTime}ms`)}`);
      }
      if (result.error) {
        console.log(`     错误: ${chalk.red(result.error)}`);
      }
      console.log('');
    } else if (options.list) {
      const status = healthChecker.getStatus();
      const unhealthy = Object.entries(status).filter(([_, v]) => v.status !== 'healthy');

      console.log(chalk.bold.cyan('📊 工具健康状态:\n'));
      for (const [name, info] of Object.entries(status)) {
        const adapter = AdapterFactory.createAll().find(a => a.name === name);
        const statusIcon = info.status === 'healthy' ? '✅' : info.status === 'unknown' ? '❓' : '❌';
        const statusColor = info.status === 'healthy' ? chalk.green : info.status === 'unknown' ? chalk.yellow : chalk.red;

        console.log(`  ${statusIcon} ${chalk.cyan(adapter?.displayName || name)}: ${statusColor(info.status)}`);
        if (info.responseTime) {
          console.log(`     响应时间: ${chalk.gray(`${info.responseTime}ms`)}`);
        }
        if (info.error) {
          console.log(`     错误: ${chalk.red(info.error)}`);
        }
      }

      if (unhealthy.length > 0) {
        console.log(chalk.yellow(`\n⚠️  ${unhealthy.length} 个工具状态异常\n`));
      } else {
        console.log(chalk.green('\n✅ 所有工具状态正常\n'));
      }
    } else if (options.report) {
      const report = healthChecker.getHealthReport();

      console.log(chalk.bold.cyan('═══════════════════════════════════════════'));
      console.log(chalk.bold.cyan('           📋 工具健康报告'));
      console.log(chalk.bold.cyan('═══════════════════════════════════════════\n'));

      console.log(`  检查时间: ${chalk.gray(report.timestamp)}`);
      console.log(`  总工具数: ${chalk.cyan(report.summary.total)}`);
      console.log(`  健康: ${chalk.green(report.summary.healthy)}`);
      console.log(`  异常: ${chalk.red(report.summary.unhealthy)}`);
      console.log(`  未知: ${chalk.yellow(report.summary.unknown)}\n`);

      console.log(chalk.bold('  详细状态:\n'));
      for (const tool of report.tools) {
        const statusIcon = tool.status === 'healthy' ? '✅' : tool.status === 'unknown' ? '❓' : '❌';
        const statusColor = tool.status === 'healthy' ? chalk.green : tool.status === 'unknown' ? chalk.yellow : chalk.red;

        console.log(`  ${statusIcon} ${chalk.cyan(tool.displayName)}: ${statusColor(tool.status)}`);
        if (tool.responseTime) {
          console.log(`     响应时间: ${chalk.gray(`${tool.responseTime}ms`)}`);
        }
        if (tool.error) {
          console.log(`     错误: ${chalk.red(tool.error)}`);
        }
        if (tool.history && tool.history.length > 0) {
          const recent = tool.history.slice(-3);
          console.log(`     最近记录: ${recent.map(h => h.status === 'healthy' ? '✓' : '✗').join(' ')}`);
        }
      }
      console.log('');
    } else {
      const results = await healthChecker.checkAll();
      const healthy = results.filter(r => r.status === 'healthy').length;
      const unhealthy = results.filter(r => r.status === 'unhealthy').length;

      console.log(chalk.bold.cyan('📊 健康检查结果:\n'));
      for (const result of results) {
        const statusIcon = result.status === 'healthy' ? '✅' : '❌';
        const statusColor = result.status === 'healthy' ? chalk.green : chalk.red;

        console.log(`  ${statusIcon} ${chalk.cyan(result.displayName)}: ${statusColor(result.status)}`);
        if (result.responseTime) {
          console.log(`     响应时间: ${chalk.gray(`${result.responseTime}ms`)}`);
        }
        if (result.error) {
          console.log(`     错误: ${chalk.red(result.error)}`);
        }
      }

      console.log('\n' + chalk.bold('总结:'));
      console.log(`  ✅ 健康: ${chalk.green(healthy)}`);
      console.log(`  ❌ 异常: ${chalk.red(unhealthy)}`);
      console.log(`  📊 健康率: ${chalk.cyan(`${Math.round((healthy / results.length) * 100)}%`)}\n`);
    }
  });

// ═══════════════════════════════════════════
// adaptive 命令族 - 自适应智能编排（P1）
// ═══════════════════════════════════════════
program
  .command('adaptive')
  .description('自适应智能编排（推荐工具/策略/模式）')
  .option('-r, --recommend <task>', '获取推荐方案')
  .option('-m, --mode <mode>', '设置编排模式 (auto|manual|hybrid)')
  .option('-s, --status', '查看编排状态')
  .option('-p, --prefs <json>', '更新用户偏好 (JSON 字符串)')
  .action(async (options) => {
    printLogo({ mini: true });
    console.log(chalk.bold.cyan('🤖 自适应智能编排\n'));

    const TaskOrchestrator = require('../core/TaskOrchestrator');
    const orch = new TaskOrchestrator({});

    if (options.recommend) {
      console.log(chalk.gray(`分析任务: ${options.recommend}\n`));
      try {
        const tools = await new (require('../utils/ToolScanner'))().scanAndConnect({ autoConnect: false });
        const rec = orch.getAdaptiveRecommendation(options.recommend, tools || []);
        console.log(chalk.green('✅ 推荐方案:'));
        console.log(`  语言: ${chalk.cyan(rec.features.language)}`);
        console.log(`  类型: ${chalk.cyan(rec.features.taskType)}`);
        console.log(`  复杂度: ${chalk.cyan(rec.features.complexity)}`);
        console.log(`  规模: ${chalk.cyan(rec.features.scale)}`);
        console.log(`  隐私: ${chalk.cyan(rec.features.privacySensitivity)}`);
        console.log(`  推荐工具: ${chalk.yellow(rec.tools.map(t => t.displayName).join(' + '))}`);
        console.log(`  策略: ${chalk.yellow(rec.strategy)} | 模式: ${chalk.yellow(rec.mode)}`);
        console.log(`  工具数: ${rec.toolCount}`);
        console.log(`  置信度: ${chalk.green(Math.round(rec.confidence * 100) + '%')}`);
        console.log(`  理由: ${chalk.gray(rec.reasoning || '')}`);
      } catch (e) {
        console.log(chalk.red(`❌ 获取推荐失败: ${e.message}`));
      }
      console.log('');
      return;
    }

    if (options.mode) {
      const validModes = ['auto', 'manual', 'hybrid'];
      if (!validModes.includes(options.mode)) {
        console.log(chalk.red(`❌ 无效模式: ${options.mode}，可选: ${validModes.join(', ')}`));
        return;
      }
      orch.setOrchestrationMode(options.mode);
      const modeNames = { auto: '自适应（全自动）', manual: '手动（用户控制）', hybrid: '混合（推荐+确认）' };
      console.log(chalk.green(`✅ 编排模式已切换: ${modeNames[options.mode]}`));
      console.log(chalk.gray('\n说明:'));
      console.log(chalk.gray('  auto: 系统分析任务后自动应用最佳工具+策略+模式'));
      console.log(chalk.gray('  manual: 完全跳过推荐，用户自选工具+策略+模式'));
      console.log(chalk.gray('  hybrid: 系统推荐但需用户确认后才应用（默认）'));
      console.log('');
      return;
    }

    if (options.status) {
      const mode = orch.getOrchestrationMode();
      const modeNames = { auto: '自适应', manual: '手动', hybrid: '混合' };
      console.log(chalk.green('📊 编排状态:'));
      console.log(`  当前模式: ${chalk.cyan(modeNames[mode] || mode)}`);
      console.log(`  推荐引擎: ${chalk.green('已启用')}`);
      console.log(`  工具学习: ${chalk.green('已加载')}`);
      console.log('');
      return;
    }

    if (options.prefs) {
      try {
        const prefs = JSON.parse(options.prefs);
        const result = orch.adaptiveOrchestrator.updatePreferences(prefs);
        console.log(chalk.green('✅ 偏好已更新:'));
        console.log(JSON.stringify(result.preferences, null, 2));
      } catch (e) {
        console.log(chalk.red(`❌ 解析 JSON 失败: ${e.message}`));
        console.log(chalk.gray('示例: qidi adaptive --prefs \'{"privacySensitivity":"high","maxParallelTools":5}\''));
      }
      console.log('');
      return;
    }

    // 默认显示帮助
    console.log(chalk.gray('用法:'));
    console.log('  qidi adaptive --recommend "用 Python 写一个爬虫"');
    console.log('  qidi adaptive --mode auto');
    console.log('  qidi adaptive --status');
    console.log('  qidi adaptive --prefs \'{"privacySensitivity":"high","maxParallelTools":5}\'');
    console.log('');
  });

program
  .command('web')
  .description('启动 Web UI 管理界面')
  .option('-p, --port <port>', '端口号', '3000')
  .option('-H, --host <host>', '主机地址', '127.0.0.1')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .action(async (options) => {
    printLogo({ banner: true });

    const WebUIServer = require('../core/WebUIServer');

    const server = new WebUIServer({
      port: parseInt(options.port),
      host: options.host,
      workspaceDir: options.workspace,
      configDir: path.join(__dirname, '../../config'),
      reportDir: './reports'
    });

    try {
      await server.start();

      console.log(chalk.cyan.bold('\n  💡 使用提示:'));
      console.log(chalk.gray('   - 在浏览器中打开上面的地址访问 Web UI'));
      console.log(chalk.gray('   - 按 Ctrl+C 停止服务器'));
      console.log(chalk.gray('   - 仪表盘显示工具状态、Agent 状态、Token 消耗等\n'));

      process.on('SIGINT', async () => {
        console.log(chalk.yellow('\n\n  正在停止服务器...'));
        await server.stop();
        console.log(chalk.green('  服务器已停止\n'));
        process.exit(0);
      });
    } catch (e) {
      console.log(chalk.red(`\n  ❌ 启动失败: ${e.message}`));
      if (e.code === 'EADDRINUSE') {
        console.log(chalk.yellow(`  💡 端口 ${options.port} 已被占用，尝试使用其他端口: qidi web -p 3001`));
      }
      process.exit(1);
    }
  });

program
  .command('chat')
  .description('启动聊天式编程助手（类似 Claude Code）')
  .option('-m, --mode <mode>', '执行模式: privacy|quality', 'privacy')
  .option('-p, --provider <provider>', '模型提供商', '')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .action(async (options) => {
    const ChatSession = require('./ChatSession');

    const session = new ChatSession({
      mode: options.mode,
      provider: options.provider || undefined,
      workspaceDir: options.workspace
    });

    await session.start();
  });

program
  .command('help')
  .description('显示帮助信息')
  .action(() => {
    printLogo();
    program.outputHelp();
  });

// ────────────────── version 命令 ──────────────────
program
  .command('version')
  .alias('v')
  .description('显示版本信息')
  .action(() => {
    const versionManager = new VersionManager();
    versionManager.printVersion();
  });

// ────────────────── update 命令 ──────────────────
program
  .command('update')
  .alias('u')
  .description('检查更新')
  .option('-c, --check', '仅检查更新，不更新')
  .option('-l, --changelog', '显示更新日志')
  .action(async (options) => {
    const versionManager = new VersionManager();

    if (options.changelog) {
      console.log(chalk.cyan('\n📋 正在获取更新日志...\n'));
      const changelog = await versionManager.getChangelog();
      console.log(chalk.gray(changelog));
    } else {
      await versionManager.printUpdateInfo();
    }
  });

// ────────────────── logs 命令 ──────────────────
program
  .command('logs')
  .alias('l')
  .description('查看日志')
  .option('-n, --lines <number>', '显示最近 N 行', '50')
  .option('-l, --level <level>', '日志级别: debug|info|warn|error', 'info')
  .option('-c, --clean', '清理旧日志')
  .action((options) => {
    const logger = new Logger({ name: 'qidi-agent' });

    if (options.clean) {
      const cleaned = logger.clean(7); // 保留7天
      console.log(chalk.green(`\n✅ 已清理 ${cleaned} 个旧日志文件\n`));
      return;
    }

    const stats = logger.getStats();
    console.log(chalk.cyan('\n📋 日志统计:\n'));
    console.log(`  文件: ${stats.file || '无'}`);
    console.log(`  大小: ${stats.sizeFormatted || '0 B'}`);
    console.log(`  行数: ${stats.lines}`);
    console.log(`  修改: ${stats.lastModified || '未知'}`);
    console.log('');
  });

// ────────────────── interactive 命令（交互式 REPL）─────────────────
program
  .command('interactive')
  .alias('i')
  .description('启动交互式编程界面（REPL模式，支持多行输入、历史记录、上下文记忆）')
  .option('-m, --mode <mode>', '默认执行模式: privacy|quality', 'privacy')
  .option('-p, --provider <provider>', '默认模型提供商: ollama|openai|anthropic', process.env.MODEL_PROVIDER || 'ollama')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .action(async (options) => {
    printLogo({ banner: true });
    const InteractiveSession = require('./InteractiveSession');
    const session = new InteractiveSession({
      workspaceDir: options.workspace,
      configDir: path.join(__dirname, '../../config'),
      mode: options.mode,
      provider: options.provider
    });
    await session.start();
  });

// ────────────────── tui 命令（Ink TUI 实验性）─────────────────
program
  .command('tui')
  .description('启动 Ink TUI 界面（实验性，功能开发中）')
  .option('-m, --mode <mode>', '执行模式: privacy|quality', 'privacy')
  .option('-p, --provider <provider>', '模型提供商: ollama|openai|anthropic', process.env.MODEL_PROVIDER || 'ollama')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .action(async (options) => {
    printLogo({ banner: true });
    console.log(chalk.yellow('  ⚠️ Ink TUI 正在开发中，部分功能不可用\n'));

    try {
      const { startTUI } = require('../tui');
      await startTUI({
        workspaceDir: options.workspace,
        mode: options.mode,
        provider: options.provider
      });
    } catch (err) {
      console.log(chalk.red(`  ❌ TUI 启动失败: ${err.message}`));
      console.log(chalk.gray('  提示: 使用 qidi interactive 获取完整的交互式体验\n'));
    }
  });

// ────────────────── help 命令 ──────────────────
program
  .command('help')
  .description('显示命令指南')
  .action(() => {
    console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║          启迪 Agent (Qidi) 命令指南                       ║'));
    console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════════╝\n'));

    console.log(chalk.bold.yellow('📋 核心任务命令'));
    console.log(chalk.cyan('  qidi run') + chalk.gray('     运行单个代码任务'));
    console.log('    ' + chalk.white('--mode <mode>') + chalk.gray('  执行模式: privacy(默认)|quality'));
    console.log('    ' + chalk.white('-t, --task <desc>') + chalk.gray('  任务描述'));
    console.log('    ' + chalk.white('-p, --provider') + chalk.gray('  模型提供商: ollama|openai|anthropic'));
    console.log('    ' + chalk.white('-w, --workspace') + chalk.gray('  工作目录 (默认 ./workspace)'));
    console.log('    ' + chalk.white('-v, --verbose') + chalk.gray('  显示详细日志'));
    console.log('');
    console.log(chalk.cyan('  qidi multi') + chalk.gray('   多 Agent 并行分派'));
    console.log('    ' + chalk.white('-t, --task <desc>') + chalk.gray('  任务描述'));
    console.log('    ' + chalk.white('-m, --mode <mode>') + chalk.gray('  分派模式: parallel|sequential|select|cascade|merge|privacy|quality'));
    console.log('    ' + chalk.white('-a, --agents <list>') + chalk.gray('  指定 Agent 列表(逗号分隔)'));
    console.log('    ' + chalk.white('-w, --workspace') + chalk.gray('  工作目录'));
    console.log('');

    console.log(chalk.bold.yellow('🔍 工具扫描与管理'));
    console.log(chalk.cyan('  qidi scan') + chalk.gray('    扫描本机已安装的 AI 编程工具'));
    console.log('    ' + chalk.white('-s, --save') + chalk.gray('  保存扫描结果到配置文件'));
    console.log('    ' + chalk.white('-c, --connect') + chalk.gray('  扫描后自动连接'));
    console.log('');
    console.log(chalk.cyan('  qidi connect') + chalk.gray('  连接 AI 编程工具'));
    console.log('    ' + chalk.white('-a, --auto') + chalk.gray('  自动接入所有已发现的工具'));
    console.log('    ' + chalk.white('-t, --tool <name>') + chalk.gray('  连接指定工具'));
    console.log('    ' + chalk.white('-s, --scan') + chalk.gray('  先扫描再连接'));
    console.log('');
    console.log(chalk.cyan('  qidi agents') + chalk.gray('   查看/管理 Agent'));
    console.log('    ' + chalk.white('-l, --list') + chalk.gray('  列出所有 Agent'));
    console.log('    ' + chalk.white('-e, --enable <name>') + chalk.gray('  启用 Agent'));
    console.log('    ' + chalk.white('-d, --disable <name>') + chalk.gray('  禁用 Agent'));
    console.log('    ' + chalk.white('-c, --check') + chalk.gray('  检查所有 Agent 连接状态'));
    console.log('');

    console.log(chalk.bold.yellow('📊 报告与历史'));
    console.log(chalk.cyan('  qidi reports') + chalk.gray('  列出实验报告'));
    console.log('    ' + chalk.white('-c, --count <n>') + chalk.gray('  显示数量 (默认 10)'));
    console.log('');
    console.log(chalk.cyan('  qidi report') + chalk.gray('  查看指定报告'));
    console.log('    ' + chalk.white('<id>') + chalk.gray('  报告 ID'));
    console.log('');
    console.log(chalk.cyan('  qidi context') + chalk.gray('  查看历史上下文'));
    console.log('    ' + chalk.white('-c, --count <n>') + chalk.gray('  显示最近报告数量 (默认 3)'));
    console.log('');

    console.log(chalk.bold.yellow('🔧 系统管理'));
    console.log(chalk.cyan('  qidi check') + chalk.gray('   检查 AI 模型连接状态'));
    console.log('    ' + chalk.white('-p, --provider') + chalk.gray('  模型提供商: ollama|openai|anthropic'));
    console.log('');
    console.log(chalk.cyan('  qidi list') + chalk.gray('    列出工作目录文件'));
    console.log('    ' + chalk.white('-w, --workspace') + chalk.gray('  工作目录'));
    console.log('    ' + chalk.white('-d, --depth <n>') + chalk.gray('  显示深度 (默认 3)'));
    console.log('');
    console.log(chalk.cyan('  qidi config') + chalk.gray('   配置管理'));
    console.log('    ' + chalk.white('-s, --show') + chalk.gray('  显示当前配置'));
    console.log('    ' + chalk.white('-l, --level <lvl>') + chalk.gray('  日志级别: debug|info|warn|error'));
    console.log('');
    console.log(chalk.cyan('  qidi web') + chalk.gray('     启动 Web UI 管理界面'));
    console.log('    ' + chalk.white('-p, --port <port>') + chalk.gray('  端口号 (默认 3000)'));
    console.log('    ' + chalk.white('-H, --host <host>') + chalk.gray('  主机地址 (默认 127.0.0.1)'));
    console.log('    ' + chalk.white('-w, --workspace') + chalk.gray('  工作目录'));
    console.log('');
    console.log(chalk.cyan('  qidi mcp') + chalk.gray('     启动 MCP 服务器 (Model Context Protocol)'));
    console.log('    ' + chalk.white('-m, --mode <mode>') + chalk.gray('  默认执行模式 (默认 privacy)'));
    console.log('    ' + chalk.white('-p, --provider') + chalk.gray('  默认模型提供商'));
    console.log('    ' + chalk.white('-w, --workspace') + chalk.gray('  工作目录'));
    console.log('');

    console.log(chalk.bold.yellow('💡 快速示例'));
    console.log(chalk.green('  qidi scan') + chalk.gray('                          # 扫描本机 AI 工具'));
    console.log(chalk.green('  qidi run -t "写一个爬虫"') + chalk.gray('              # 隐私模式执行'));
    console.log(chalk.green('  qidi run -t "写贪吃蛇" --mode quality') + chalk.gray('  # 高质量模式'));
    console.log(chalk.green('  qidi multi -t "REST API" -m parallel') + chalk.gray('  # 多Agent并行'));
    console.log(chalk.green('  qidi web -p 8080') + chalk.gray('               # Web UI 指定端口'));
    console.log(chalk.green('  qidi mcp') + chalk.gray('                          # 启动 MCP 服务器'));
    console.log(chalk.green('  qidi help') + chalk.gray('                          # 显示本指南'));
    console.log('');
  });

// ────────────────── mcp 命令（MCP 协议服务器）──────────────────
program
  .command('mcp')
  .description('启动 MCP (Model Context Protocol) 服务器，将 Qidi 能力暴露给 MCP 兼容客户端')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .option('-m, --mode <mode>', '默认执行模式: privacy|quality|efficiency|multi', 'privacy')
  .option('-p, --provider <provider>', '默认模型提供商', process.env.MODEL_PROVIDER || 'ollama')
  .action(async (options) => {
    const MCPServer = require('../mcp/MCPServer');

    const server = new MCPServer({
      workspaceDir: options.workspace,
      configDir: path.join(__dirname, '../../config'),
      reportDir: './reports',
      defaultProvider: options.provider,
      defaultMode: options.mode
    });

    await server.start();
  });

// ────────────────── config 命令 ──────────────────
program
  .command('config')
  .description('配置管理')
  .option('-s, --show', '显示当前配置')
  .option('-l, --level <level>', '设置日志级别: debug|info|warn|error')
  .action((options) => {
    const configFile = path.join(__dirname, '../../config/agents.json');

    if (options.show) {
      try {
        const config = safeJsonParse(fs.readFileSync(configFile, 'utf8'), {});
        console.log(chalk.cyan('\n⚙️ 当前配置:\n'));
        console.log(JSON.stringify(config, null, 2));
      } catch {
        console.log(chalk.yellow('\n⚠️ 配置文件不存在\n'));
      }
    } else if (options.level) {
      process.env.LOG_LEVEL = options.level;
      console.log(chalk.green(`\n✅ 日志级别已设置为: ${options.level}\n`));
    } else {
      program.outputHelp();
    }
  });

// ────────────────── G4: 增强模块命令 ──────────────────

// ── test 命令 ──
program
  .command('test')
  .description('G4: 运行测试')
  .option('-f, --file <path>', '测试文件路径')
  .option('-l, --language <lang>', '测试语言', 'javascript')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .action(async (options) => {
    printLogo({ mini: true });
    console.log(chalk.bold.cyan('🧪 测试执行器\n'));

    const TestRunner = require('../core/TestRunner');
    const runner = new TestRunner({ workspaceDir: options.workspace });

    try {
      const fs2 = require('fs');
      let testCode = '';
      if (options.file && fs2.existsSync(options.file)) {
        testCode = fs2.readFileSync(options.file, 'utf-8');
      } else {
        console.log(chalk.yellow('⚠️  未指定测试文件，运行语法检查模式'));
        testCode = '';
      }

      const result = await runner.runTests({
        testCode,
        language: options.language,
        workspaceDir: options.workspace
      });

      console.log(chalk.bold('\n📊 测试结果:\n'));
      console.log(`  通过: ${chalk.green(result.passed || 0)}/${result.total || 0}`);
      console.log(`  失败: ${chalk.red(result.failed || 0)}`);
      if (result.duration) {
        console.log(`  耗时: ${chalk.gray(result.duration + 'ms')}`);
      }
      if (result.output) {
        console.log(chalk.gray('\n  输出:\n' + result.output));
      }
      console.log('');
    } catch (e) {
      console.log(chalk.red(`\n❌ 测试失败: ${e.message}\n`));
      process.exit(1);
    }
  });

// ── budget 命令 ──
program
  .command('budget')
  .description('G4: Token 预算管理')
  .option('-s, --set <tokens>', '设置总预算')
  .option('-r, --report', '生成预算报告')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .action(async (options) => {
    printLogo({ mini: true });
    console.log(chalk.bold.cyan('💰 Token 预算管理\n'));

    const BudgetManager = require('../core/BudgetManager');
    const bm = new BudgetManager({ totalBudget: parseInt(options.set) || 1000000 });

    if (options.set) {
      console.log(chalk.green(`✅ 总预算已设置为: ${parseInt(options.set).toLocaleString()} tokens`));
    }

    if (options.report) {
      const report = bm.generateReport();
      console.log(chalk.bold('\n📋 预算报告:\n'));
      console.log(`  总预算: ${chalk.cyan(report.totalBudget.toLocaleString())}`);
      console.log(`  已使用: ${chalk.yellow(report.usedTokens.toLocaleString())} (${report.usageRate}%)`);
      console.log(`  剩余: ${chalk.green(report.remaining.toLocaleString())}`);
      if (report.byPhase && Object.keys(report.byPhase).length > 0) {
        console.log(chalk.bold('\n  各阶段消耗:'));
        for (const [phase, data] of Object.entries(report.byPhase)) {
          console.log(`    ${phase}: ${data.tokens.toLocaleString()} tokens`);
        }
      }
      console.log('');
    } else if (!options.set) {
      console.log(chalk.gray('  使用 --set 设置预算, --report 生成报告'));
      console.log('');
    }
  });

// ── git 命令 ──
program
  .command('git')
  .description('G4: Git 集成管理')
  .option('-s, --status', '查看 Git 状态')
  .option('-b, --branch <name>', '创建任务分支')
  .option('-c, --commit <msg>', '提交变更')
  .option('-r, --rollback [savepoint]', '回滚到保存点')
  .option('-w, --workspace <dir>', '工作目录', './workspace')
  .action(async (options) => {
    printLogo({ mini: true });
    console.log(chalk.bold.cyan('🌿 Git 集成管理\n'));

    const GitIntegration = require('../core/GitIntegration');
    const git = new GitIntegration({ workspaceDir: options.workspace });

    if (options.status) {
      console.log(`  启用: ${git.isEnabled() ? chalk.green('是') : chalk.red('否')}`);
      console.log(`  当前分支: ${chalk.cyan(git.getCurrentBranch())}`);
      const savepoints = git.getSavepoints ? git.getSavepoints() : [];
      if (savepoints.length > 0) {
        console.log(chalk.bold('\n  保存点:'));
        savepoints.forEach(sp => {
          console.log(`    ${chalk.cyan(sp.id)} - ${sp.message || '无消息'} (${sp.timestamp})`);
        });
      }
      console.log('');
    } else if (options.branch) {
      git.createTaskBranch(options.branch);
      console.log(chalk.green(`✅ 已创建分支: ${options.branch}\n`));
    } else if (options.commit) {
      const hash = git.commitChanges(Date.now().toString(), options.commit);
      if (hash) {
        console.log(chalk.green(`✅ 已提交: ${hash}\n`));
      } else {
        console.log(chalk.yellow('⚠️  无变更可提交\n'));
      }
    } else if (options.rollback) {
      git.rollback(typeof options.rollback === 'string' ? options.rollback : undefined);
      console.log(chalk.green('✅ 已回滚\n'));
    } else {
      console.log(chalk.gray('  使用 --status 查看状态, --branch 创建分支, --commit 提交, --rollback 回滚'));
      console.log('');
    }
  });

// ── sandbox 命令 ──
program
  .command('sandbox')
  .description('G4: 沙箱执行代码')
  .option('-c, --code <code>', '要执行的代码')
  .option('-f, --file <path>', '代码文件路径')
  .option('-l, --language <lang>', '语言', 'javascript')
  .option('-t, --timeout <ms>', '超时(毫秒)', '10000')
  .action(async (options) => {
    printLogo({ mini: true });
    console.log(chalk.bold.cyan('🔬 沙箱执行器\n'));

    const SandboxExecutor = require('../core/SandboxExecutor');
    const sandbox = new SandboxExecutor({ timeout: parseInt(options.timeout) });

    let code = options.code || '';
    if (!code && options.file) {
      const fs2 = require('fs');
      if (fs2.existsSync(options.file)) {
        code = fs2.readFileSync(options.file, 'utf-8');
      } else {
        console.log(chalk.red(`❌ 文件不存在: ${options.file}\n`));
        process.exit(1);
      }
    }

    if (!code) {
      console.log(chalk.yellow('⚠️  请通过 --code 或 --file 提供代码'));
      console.log('');
      return;
    }

    try {
      const result = await sandbox.execute(code, options.language, { timeout: parseInt(options.timeout) });
      console.log(chalk.bold('\n📊 执行结果:\n'));
      console.log(`  状态: ${result.success ? chalk.green('成功') : chalk.red('失败')}`);
      if (result.stdout) {
        console.log(`  输出:\n${chalk.gray(result.stdout)}`);
      }
      if (result.stderr) {
        console.log(`  错误:\n${chalk.red(result.stderr)}`);
      }
      if (result.duration) {
        console.log(`  耗时: ${chalk.gray(result.duration + 'ms')}`);
      }
      console.log('');
    } catch (e) {
      console.log(chalk.red(`\n❌ 执行失败: ${e.message}\n`));
      process.exit(1);
    }
  });

// ── approval 命令 ──
program
  .command('approval')
  .description('G4: 人工审批工作流')
  .option('-l, --list', '列出待审批')
  .option('-a, --approve <id>', '批准审批')
  .option('-r, --reject <id>', '拒绝审批')
  .option('-m, --message <msg>', '审批消息', '')
  .action(async (options) => {
    printLogo({ mini: true });
    console.log(chalk.bold.cyan('🔐 审批工作流\n'));

    const ApprovalWorkflow = require('../core/ApprovalWorkflow');
    const aw = new ApprovalWorkflow();

    if (options.list) {
      const pending = aw.getPendingApprovals();
      if (pending.length === 0) {
        console.log(chalk.gray('  无待审批项\n'));
      } else {
        console.log(chalk.bold('  待审批项:'));
        pending.forEach(p => {
          console.log(`    ${chalk.cyan(p.id)} - ${p.type} - ${p.data?.task || '未知'} (${p.timestamp})`);
        });
        console.log('');
      }
    } else if (options.approve) {
      const result = aw.approve(options.approve, options.message);
      console.log(chalk.green(`✅ 已批准: ${options.approve}\n`));
    } else if (options.reject) {
      const result = aw.reject(options.reject, options.message);
      console.log(chalk.yellow(`⚠️  已拒绝: ${options.reject}\n`));
    } else {
      console.log(chalk.gray('  使用 --list 查看, --approve 批准, --reject 拒绝'));
      console.log('');
    }
  });

if (!process.argv.slice(2).length) {
  printLogo();
  program.outputHelp();
}

program.parse(process.argv);
