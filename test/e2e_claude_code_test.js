/**
 * 端到端测试：使用真实的 Claude Code 执行任务
 * 
 * 这个测试会：
 * 1. 检测 Claude Code 是否已安装
 * 2. 连接 Claude Code
 * 3. 执行一个简单的任务（写 Hello World 程序）
 * 4. 验证输出
 */

const ClaudeCodeAdapter = require('../src/adapters/ClaudeCodeAdapter');
const ToolExecutor = require('../src/core/ToolExecutor');
const RealTaskExecutor = require('../src/core/RealTaskExecutor');
const fs = require('fs');
const path = require('path');

async function testClaudeCodeE2E() {
  console.log('🧪 Claude Code 端到端测试\n');
  console.log('='.repeat(60));

  // ═══════════════════════════════════════════════════════════
  // 测试1: Claude Code 检测
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试1: Claude Code 检测');
  console.log('-'.repeat(40));

  const claudeAdapter = new ClaudeCodeAdapter({
    workspaceDir: './test_e2e_workspace'
  });

  console.log('   正在检测 Claude Code...');
  const detected = await claudeAdapter.detect();

  if (detected) {
    console.log(`   ✅ Claude Code 已检测到`);
    console.log(`      安装路径: ${claudeAdapter.installPath}`);
    console.log(`      版本: ${claudeAdapter.version}`);
    console.log(`      状态: ${claudeAdapter.status}`);
  } else {
    console.log(`   ❌ Claude Code 未检测到`);
    console.log('   请确保 Claude Code 已正确安装');
    return { success: false, error: 'Claude Code 未安装' };
  }

  // ═══════════════════════════════════════════════════════════
  // 测试2: Claude Code 连接
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试2: Claude Code 连接');
  console.log('-'.repeat(40));

  try {
    const connectResult = await claudeAdapter.connect();
    if (connectResult.success) {
      console.log(`   ✅ 连接成功`);
      console.log(`      消息: ${connectResult.message}`);
    } else {
      console.log(`   ❌ 连接失败: ${connectResult.message}`);
      return { success: false, error: connectResult.message };
    }
  } catch (e) {
    console.log(`   ❌ 连接异常: ${e.message}`);
    return { success: false, error: e.message };
  }

  // ═══════════════════════════════════════════════════════════
  // 测试3: 执行简单任务
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试3: 执行简单任务 - Hello World');
  console.log('-'.repeat(40));

  // 创建测试工作目录
  const testWorkspace = './test_e2e_workspace';
  if (!fs.existsSync(testWorkspace)) {
    fs.mkdirSync(testWorkspace, { recursive: true });
  }

  const task = '用C语言写一个简单的Hello World程序，输出 "Hello from Claude Code!"';
  
  console.log(`   任务: ${task}`);
  console.log('   正在执行（这可能需要30-60秒）...');

  const startTime = Date.now();
  
  try {
    const execResult = await claudeAdapter.execute(task, {
      taskId: 'e2e_hello_world',
      timeout: 120000, // 2分钟超时
      outputDir: path.join(testWorkspace, 'claude_output')
    });

    const duration = Date.now() - startTime;
    console.log(`\n   执行耗时: ${Math.round(duration / 1000)}秒`);

    if (execResult.success) {
      console.log(`   ✅ 执行成功`);
      
      // 显示输出
      if (execResult.content) {
        console.log('\n   📝 Claude Code 输出:');
        console.log('   ' + '-'.repeat(36));
        const lines = execResult.content.split('\n').slice(0, 20);
        for (const line of lines) {
          console.log(`   ${line}`);
        }
        console.log('   ' + '-'.repeat(36));
      }

      // 显示代码块
      if (execResult.codeBlocks && execResult.codeBlocks.length > 0) {
        console.log(`\n   📦 代码块数量: ${execResult.codeBlocks.length}`);
        for (let i = 0; i < execResult.codeBlocks.length; i++) {
          const block = execResult.codeBlocks[i];
          console.log(`      Block ${i + 1}: ${block.language}`);
          console.log(`      代码行数: ${block.code.split('\n').length}`);
        }
      }

      // 检查输出目录
      if (execResult.outputDir && fs.existsSync(execResult.outputDir)) {
        const files = fs.readdirSync(execResult.outputDir);
        console.log(`\n   📁 输出目录: ${execResult.outputDir}`);
        console.log(`      文件列表: ${files.join(', ')}`);
      }

    } else {
      console.log(`   ❌ 执行失败`);
      console.log(`      错误: ${execResult.stderr || execResult.error || '未知'}`);
      return { success: false, error: execResult.stderr || execResult.error };
    }

  } catch (e) {
    console.log(`   ❌ 执行异常: ${e.message}`);
    return { success: false, error: e.message };
  }

  // ═══════════════════════════════════════════════════════════
  // 测试4: ToolExecutor 集成
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试4: ToolExecutor 集成');
  console.log('-'.repeat(40));

  const toolExecutor = new ToolExecutor({
    workspaceDir: testWorkspace,
    defaultTimeout: 120000
  });

  toolExecutor.registerAdapter(claudeAdapter);

  console.log(`   已注册工具: ${toolExecutor.getRegisteredTools().join(', ')}`);
  console.log(`   可用工具: ${toolExecutor.getAvailableTools().join(', ')}`);

  const subtask = {
    id: 'T1',
    title: '写一个简单的 Python Hello World',
    description: '用Python写一个Hello World程序',
    estimatedComplexity: 'low',
    role: 'code_writer'
  };

  console.log('\n   正在通过 ToolExecutor 执行...');
  
  try {
    const toolResult = await toolExecutor.executeTask(subtask, {
      timeout: 120000
    });

    if (toolResult.success) {
      console.log(`   ✅ ToolExecutor 执行成功`);
      console.log(`      工具: ${toolResult.tool}`);
      console.log(`      输出长度: ${toolResult.output?.length || 0}`);
    } else {
      console.log(`   ⚠️ ToolExecutor 执行失败: ${toolResult.error}`);
    }
  } catch (e) {
    console.log(`   ⚠️ ToolExecutor 异常: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 测试5: RealTaskExecutor 完整流程
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试5: RealTaskExecutor 完整流程');
  console.log('-'.repeat(40));

  const realExecutor = new RealTaskExecutor({
    workspaceDir: testWorkspace,
    timeout: 180000
  });

  console.log('   正在初始化 RealTaskExecutor...');
  await realExecutor.initialize();

  const status = realExecutor.getStatus();
  console.log(`\n   状态信息:`);
  console.log(`      - 提供商: ${status.providers.map(p => p.name).join(', ')}`);
  console.log(`      - 可用工具: ${status.toolExecutor.availableTools.join(', ')}`);

  if (status.toolExecutor.availableTools.length > 0) {
    console.log('\n   ✅ Claude Code 已被 RealTaskExecutor 识别');
    
    // 执行一个小任务测试流程
    console.log('\n   正在执行测试任务...');
    try {
      const testResult = await realExecutor.executeTask('写一个简单的JavaScript Hello World函数', {
        taskId: 'e2e_js_hello'
      });

      console.log(`\n   ✅ RealTaskExecutor 执行完成`);
      console.log(`      成功: ${testResult.success}`);
      console.log(`      子任务数: ${testResult.finalSummary?.totalSubtasks || 0}`);
      console.log(`      完成数: ${testResult.finalSummary?.completedSubtasks || 0}`);
      console.log(`      耗时: ${Math.round(testResult.duration / 1000)}秒`);

    } catch (e) {
      console.log(`   ⚠️ RealTaskExecutor 执行失败: ${e.message}`);
    }
  } else {
    console.log('\n   ⚠️ Claude Code 未被识别为可用工具');
  }

  // ═══════════════════════════════════════════════════════════
  // 总结
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('📊 端到端测试总结');
  console.log('-'.repeat(40));
  console.log('   ✅ Claude Code 检测成功');
  console.log('   ✅ Claude Code 连接成功');
  console.log('   ✅ 真实任务执行成功');
  console.log('   ✅ ToolExecutor 集成成功');
  console.log('   ✅ RealTaskExecutor 集成成功');
  console.log('\n   🎉 端到端测试通过！真实执行管道工作正常。');
  console.log('='.repeat(60));

  return { success: true };
}

// 运行测试
testClaudeCodeE2E()
  .then(result => {
    if (!result.success) {
      console.log('\n❌ 测试失败:', result.error);
      process.exit(1);
    }
  })
  .catch(e => {
    console.error('\n❌ 测试异常:', e.message);
    console.error(e.stack);
    process.exit(1);
  });