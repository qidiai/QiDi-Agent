#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const path = require('path');

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
  .option('-m, --mode <mode>', '执行模式: privacy|quality', 'privacy')
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
    const modeDisplay = options.mode === 'privacy' ? '🔒 隐私模式' : '✨ 高质量模式';
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

    const orchestrator = new TaskOrchestrator(provider, {
      workspaceDir: options.workspace,
      verbose: options.verbose,
      toolAdapters: registeredTools,
      executionMode: options.mode  // 传入执行模式
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

function setupEventListeners(orchestrator, verbose) {
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
        console.log(chalk.yellow(`   ⚠️ 需要返工`));
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
        console.log(chalk.gray(`   📊 工具产出对比:`));
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

function printSummary(result) {
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
        const statusText = result.status === 'online' ? chalk.green('在线') : 
                          result.status === 'offline' ? chalk.yellow('离线') : 
                          chalk.red('错误');
        
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

function getRoleIcon(role) {
  const icons = {
    code_writer: '💻',
    code_reviewer: '🔍',
    tester: '🧪',
    architect: '🏗️'
  };
  return icons[role] || '📋';
}

function getComplexityColor(complexity) {
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
    console.log(chalk.cyan('  qidi run')     + chalk.gray('     运行单个代码任务'));
    console.log(                '    ' + chalk.white('--mode <mode>')     + chalk.gray('  执行模式: privacy(默认)|quality'));
    console.log(                '    ' + chalk.white('-t, --task <desc>') + chalk.gray('  任务描述'));
    console.log(                '    ' + chalk.white('-p, --provider')    + chalk.gray('  模型提供商: ollama|openai|anthropic'));
    console.log(                '    ' + chalk.white('-w, --workspace')   + chalk.gray('  工作目录 (默认 ./workspace)'));
    console.log(                '    ' + chalk.white('-v, --verbose')     + chalk.gray('  显示详细日志'));
    console.log('');
    console.log(chalk.cyan('  qidi multi')  + chalk.gray('   多 Agent 并行分派'));
    console.log(                '    ' + chalk.white('-t, --task <desc>') + chalk.gray('  任务描述'));
    console.log(                '    ' + chalk.white('-m, --mode <mode>') + chalk.gray('  分派模式: parallel|sequential|select|cascade|merge|privacy|quality'));
    console.log(                '    ' + chalk.white('-a, --agents <list>')+ chalk.gray('  指定 Agent 列表(逗号分隔)'));
    console.log(                '    ' + chalk.white('-w, --workspace')   + chalk.gray('  工作目录'));
    console.log('');

    console.log(chalk.bold.yellow('🔍 工具扫描与管理'));
    console.log(chalk.cyan('  qidi scan')    + chalk.gray('    扫描本机已安装的 AI 编程工具'));
    console.log(                '    ' + chalk.white('-s, --save')        + chalk.gray('  保存扫描结果到配置文件'));
    console.log(                '    ' + chalk.white('-c, --connect')     + chalk.gray('  扫描后自动连接'));
    console.log('');
    console.log(chalk.cyan('  qidi connect') + chalk.gray('  连接 AI 编程工具'));
    console.log(                '    ' + chalk.white('-a, --auto')        + chalk.gray('  自动接入所有已发现的工具'));
    console.log(                '    ' + chalk.white('-t, --tool <name>') + chalk.gray('  连接指定工具'));
    console.log(                '    ' + chalk.white('-s, --scan')        + chalk.gray('  先扫描再连接'));
    console.log('');
    console.log(chalk.cyan('  qidi agents')  + chalk.gray('   查看/管理 Agent'));
    console.log(                '    ' + chalk.white('-l, --list')        + chalk.gray('  列出所有 Agent'));
    console.log(                '    ' + chalk.white('-e, --enable <name>')+chalk.gray('  启用 Agent'));
    console.log(                '    ' + chalk.white('-d, --disable <name>')+chalk.gray('  禁用 Agent'));
    console.log(                '    ' + chalk.white('-c, --check')       + chalk.gray('  检查所有 Agent 连接状态'));
    console.log('');

    console.log(chalk.bold.yellow('📊 报告与历史'));
    console.log(chalk.cyan('  qidi reports') + chalk.gray('  列出实验报告'));
    console.log(                '    ' + chalk.white('-c, --count <n>')   + chalk.gray('  显示数量 (默认 10)'));
    console.log('');
    console.log(chalk.cyan('  qidi report')  + chalk.gray('  查看指定报告'));
    console.log(                '    ' + chalk.white('<id>')              + chalk.gray('  报告 ID'));
    console.log('');
    console.log(chalk.cyan('  qidi context') + chalk.gray('  查看历史上下文'));
    console.log(                '    ' + chalk.white('-c, --count <n>')   + chalk.gray('  显示最近报告数量 (默认 3)'));
    console.log('');

    console.log(chalk.bold.yellow('🔧 系统管理'));
    console.log(chalk.cyan('  qidi check')   + chalk.gray('   检查 AI 模型连接状态'));
    console.log(                '    ' + chalk.white('-p, --provider')    + chalk.gray('  模型提供商: ollama|openai|anthropic'));
    console.log('');
    console.log(chalk.cyan('  qidi list')    + chalk.gray('    列出工作目录文件'));
    console.log(                '    ' + chalk.white('-w, --workspace')   + chalk.gray('  工作目录'));
    console.log(                '    ' + chalk.white('-d, --depth <n>')   + chalk.gray('  显示深度 (默认 3)'));
    console.log('');
    console.log(chalk.cyan('  qidi config')  + chalk.gray('   配置管理'));
    console.log(                '    ' + chalk.white('-s, --show')        + chalk.gray('  显示当前配置'));
    console.log(                '    ' + chalk.white('-l, --level <lvl>') + chalk.gray('  日志级别: debug|info|warn|error'));
    console.log('');
    console.log(chalk.cyan('  qidi web')     + chalk.gray('     启动 Web UI 管理界面'));
    console.log(                '    ' + chalk.white('-p, --port <port>') + chalk.gray('  端口号 (默认 3000)'));
    console.log(                '    ' + chalk.white('-H, --host <host>') + chalk.gray('  主机地址 (默认 127.0.0.1)'));
    console.log(                '    ' + chalk.white('-w, --workspace')   + chalk.gray('  工作目录'));
    console.log('');

    console.log(chalk.bold.yellow('💡 快速示例'));
    console.log(chalk.green('  qidi scan')                    + chalk.gray('                          # 扫描本机 AI 工具'));
    console.log(chalk.green('  qidi run -t "写一个爬虫"')     + chalk.gray('              # 隐私模式执行'));
    console.log(chalk.green('  qidi run -t "写贪吃蛇" --mode quality') + chalk.gray('  # 高质量模式'));
    console.log(chalk.green('  qidi multi -t "REST API" -m parallel') + chalk.gray('  # 多Agent并行'));
    console.log(chalk.green('  qidi web -p 8080')             + chalk.gray('               # Web UI 指定端口'));
    console.log(chalk.green('  qidi help')                    + chalk.gray('                          # 显示本指南'));
    console.log('');
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
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
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

if (!process.argv.slice(2).length) {
  printLogo();
  program.outputHelp();
}

program.parse(process.argv);
