/**
 * 多工具端到端测试：测试 Qoder 和 AtomCode
 */

const ClaudeCodeAdapter = require('../src/adapters/ClaudeCodeAdapter');
const QoderAdapter = require('../src/adapters/QoderAdapter');
const AtomCodeAdapter = require('../src/adapters/AtomCodeAdapter');
const ToolExecutor = require('../src/core/ToolExecutor');
const fs = require('fs');
const path = require('path');

async function testMultipleTools() {
  console.log('🧪 多工具端到端测试\n');
  console.log('='.repeat(60));

  const results = {};
  const testWorkspace = './test_multi_tool_workspace';
  
  if (!fs.existsSync(testWorkspace)) {
    fs.mkdirSync(testWorkspace, { recursive: true });
  }

  const adapters = [
    { name: 'Claude Code', adapter: new ClaudeCodeAdapter({ workspaceDir: testWorkspace }) },
    { name: 'Qoder', adapter: new QoderAdapter({ workspaceDir: testWorkspace }) },
    { name: 'AtomCode', adapter: new AtomCodeAdapter({ workspaceDir: testWorkspace }) }
  ];

  // ═══════════════════════════════════════════════════════════
  // 测试1: 工具检测
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试1: 工具检测');
  console.log('-'.repeat(40));

  for (const { name, adapter } of adapters) {
    console.log(`   正在检测 ${name}...`);
    const detected = await adapter.detect();
    
    if (detected) {
      console.log(`   ✅ ${name} 已检测到`);
      console.log(`      安装路径: ${adapter.installPath}`);
      console.log(`      状态: ${adapter.status}`);
      results[name] = { detected: true, adapter };
    } else {
      console.log(`   ❌ ${name} 未检测到`);
      results[name] = { detected: false };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 测试2: 工具连接
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试2: 工具连接');
  console.log('-'.repeat(40));

  for (const { name, adapter } of adapters) {
    if (!results[name].detected) {
      console.log(`   ⏭️ ${name} 未检测到，跳过连接测试`);
      continue;
    }

    try {
      const connectResult = await adapter.connect();
      if (connectResult.success) {
        console.log(`   ✅ ${name} 连接成功`);
        results[name].connected = true;
      } else {
        console.log(`   ❌ ${name} 连接失败: ${connectResult.message}`);
        results[name].connected = false;
      }
    } catch (e) {
      console.log(`   ❌ ${name} 连接异常: ${e.message}`);
      results[name].connected = false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 测试3: 执行任务
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试3: 执行任务');
  console.log('-'.repeat(40));

  const task = '写一个简单的 Python Hello World 函数';

  for (const { name, adapter } of adapters) {
    if (!results[name].detected || !results[name].connected) {
      console.log(`   ⏭️ ${name} 不可用，跳过执行测试`);
      continue;
    }

    console.log(`\n   正在执行 ${name}...`);
    console.log(`   任务: ${task}`);
    
    const startTime = Date.now();
    
    try {
      const execResult = await adapter.execute(task, {
        taskId: `multi_tool_test_${name.toLowerCase().replace(' ', '_')}`,
        timeout: 300000,
        verbose: false
      });

      const duration = Date.now() - startTime;
      
      if (execResult.success) {
        console.log(`   ✅ ${name} 执行成功（${Math.round(duration / 1000)}秒）`);
        
        if (execResult.codeBlocks && execResult.codeBlocks.length > 0) {
          console.log(`   📦 代码块数量: ${execResult.codeBlocks.length}`);
          for (let i = 0; i < Math.min(execResult.codeBlocks.length, 2); i++) {
            const block = execResult.codeBlocks[i];
            console.log(`      Block ${i + 1}: ${block.language}`);
            console.log(`      代码: ${block.code.substring(0, 80)}${block.code.length > 80 ? '...' : ''}`);
          }
        }

        results[name].executionSuccess = true;
        results[name].codeBlocks = execResult.codeBlocks;
        results[name].duration = duration;
        
      } else {
        console.log(`   ❌ ${name} 执行失败`);
        console.log(`      错误: ${execResult.stderr || execResult.error || '未知'}`);
        results[name].executionSuccess = false;
        results[name].error = execResult.stderr || execResult.error;
      }
    } catch (e) {
      console.log(`   ❌ ${name} 执行异常: ${e.message}`);
      results[name].executionSuccess = false;
      results[name].error = e.message;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 测试4: ToolExecutor 多工具并行
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试4: ToolExecutor 多工具并行执行');
  console.log('-'.repeat(40));

  const executor = new ToolExecutor({
    workspaceDir: testWorkspace,
    defaultTimeout: 120000
  });

  const availableAdapters = adapters.filter(a => results[a.name].detected && results[a.name].connected);
  
  if (availableAdapters.length === 0) {
    console.log('   ❌ 没有可用的工具');
  } else {
    for (const { name, adapter } of availableAdapters) {
      executor.registerAdapter(adapter);
    }
    
    console.log(`   已注册工具: ${executor.getRegisteredTools().join(', ')}`);
    
    const subtask = {
      id: 'T1',
      title: '写一个简单的 JavaScript 函数',
      description: '写一个计算两数之和的函数',
      estimatedComplexity: 'low',
      role: 'code_writer'
    };

    console.log('\n   正在并行执行...');
    const startTime = Date.now();
    
    const toolNames = availableAdapters.map(a => a.adapter.name);
    const multiResult = await executor.executeWithTools(
      [subtask],
      toolNames,
      { mode: 'parallel', timeout: 120000 }
    );

    const duration = Date.now() - startTime;
    console.log(`   执行完成（${Math.round(duration / 1000)}秒）`);
    
    for (const result of multiResult.results) {
      const adapterName = availableAdapters.find(a => a.adapter.name === result.tool)?.name || result.tool;
      console.log(`   ${result.success ? '✅' : '❌'} ${adapterName}: ${result.success ? '成功' : result.error}`);
    }
    
    if (multiResult.bestResult) {
      console.log(`\n   最佳结果: ${multiResult.bestResult.tool}（评分: ${multiResult.bestScore}）`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 总结
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('📊 多工具测试总结');
  console.log('-'.repeat(40));
  
  for (const { name } of adapters) {
    const r = results[name];
    console.log(`\n   ${name}:`);
    console.log(`      检测: ${r.detected ? '✅ 通过' : '❌ 失败'}`);
    if (r.detected) {
      console.log(`      连接: ${r.connected ? '✅ 通过' : '❌ 失败'}`);
      if (r.connected) {
        console.log(`      执行: ${r.executionSuccess ? '✅ 通过' : '❌ 失败'}`);
        if (r.executionSuccess) {
          console.log(`      耗时: ${Math.round(r.duration / 1000)}秒`);
          console.log(`      代码块: ${r.codeBlocks?.length || 0} 个`);
        } else {
          console.log(`      错误: ${r.error}`);
        }
      }
    }
  }
  
  const successCount = Object.values(results).filter(r => r.executionSuccess).length;
  const totalCount = adapters.length;
  
  console.log(`\n   总计: ${successCount}/${totalCount} 工具执行成功`);
  
  if (successCount === totalCount) {
    console.log('   🎉 所有工具测试通过！');
  } else if (successCount > 0) {
    console.log('   ⚠️ 部分工具测试通过');
  } else {
    console.log('   ❌ 所有工具测试失败');
  }
  
  console.log('='.repeat(60));

  return { success: successCount > 0, results };
}

testMultipleTools().catch(e => {
  console.error('❌ 测试异常:', e.message);
  console.error(e.stack);
  process.exit(1);
});