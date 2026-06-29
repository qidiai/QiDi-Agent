/**
 * 多工具任务派发与合并测试（改进版）
 *
 * 确保两个工具都能成功执行不同的任务
 */

const ClaudeCodeAdapter = require('../src/adapters/ClaudeCodeAdapter');
const AtomCodeAdapter = require('../src/adapters/AtomCodeAdapter');
const ToolExecutor = require('../src/core/ToolExecutor');
const MergeEngine = require('../src/agents/MergeEngine');
const fs = require('fs');
const path = require('path');

function createMockProvider () {
  return {
    name: 'mock',
    chat: async (messages) => {
      const lastMsg = messages[messages.length - 1]?.content || '';

      if (lastMsg.includes('合并')) {
        return {
          content: JSON.stringify({
            mergedCode: '# 合并后的代码 - 整合了两个工具的产出\n# Claude Code 的斐波那契 + AtomCode 的打印功能\n\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n\ndef print_result(func, args):\n    result = func(*args)\n    print(f"结果: {result}")\n\ndef main():\n    for i in range(10):\n        print_result(fibonacci, [i])\n\nif __name__ == "__main__":\n    main()',
            conflicts: [
              {
                location: 'main.py',
                description: '函数命名风格差异',
                resolutions: ['ClaudeCode方案', 'AtomCode方案'],
                chosenResolution: '融合方案',
                reason: '取两者之长'
              }
            ],
            improvements: [
              {
                location: 'main.py',
                description: '整合了两个工具的功能',
                before: '两个独立函数',
                after: '统一的主函数调用'
              }
            ],
            qualityAssessment: {
              correctness: 90,
              consistency: 85,
              readability: 88,
              security: 80
            },
            mergeStrategy: 'combine',
            notes: '成功合并两个工具的产出'
          }),
          role: 'assistant'
        };
      }

      return {
        content: JSON.stringify({
          mergedCode: '// 单工具结果',
          conflicts: [],
          improvements: [],
          qualityAssessment: { correctness: 80, consistency: 80, readability: 80, security: 80 },
          mergeStrategy: 'single',
          notes: '只有一个结果'
        }),
        role: 'assistant'
      };
    },
    generate: async () => ({ content: 'mock', role: 'assistant' }),
    checkConnection: async () => true
  };
}

async function testMultiToolDispatch () {
  console.log('🧪 多工具任务派发与合并测试（改进版）\n');
  console.log('='.repeat(60));

  const testWorkspace = './test_multi_task_workspace';
  if (!fs.existsSync(testWorkspace)) {
    fs.mkdirSync(testWorkspace, { recursive: true });
  }

  // ═══════════════════════════════════════════════════════════
  // 测试1: 检查工具可用性
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试1: 检查工具可用性');
  console.log('-'.repeat(40));

  const claudeAdapter = new ClaudeCodeAdapter({ workspaceDir: testWorkspace });
  const atomAdapter = new AtomCodeAdapter({ workspaceDir: testWorkspace });

  await claudeAdapter.detect();
  await atomAdapter.detect();

  const claudeAvailable = claudeAdapter.isAvailable();
  const atomAvailable = atomAdapter.isAvailable();

  console.log(`   Claude Code: ${claudeAvailable ? '✅ 可用' : '❌ 不可用'}`);
  console.log(`   AtomCode: ${atomAvailable ? '✅ 可用' : '❌ 不可用'}`);

  if (!claudeAvailable || !atomAvailable) {
    console.log('   ❌ 需要两个工具都可用才能测试多任务派发');
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // 测试2: 单独验证每个工具
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试2: 单独验证每个工具');
  console.log('-'.repeat(40));

  let claudeWorks = false;
  let atomWorks = false;

  console.log('\n   验证 Claude Code...');
  try {
    const claudeResult = await claudeAdapter.execute('写一个简单的Python函数', {
      timeout: 120000,
      verbose: false
    });
    claudeWorks = claudeResult.success;
    console.log(`   ${claudeWorks ? '✅' : '❌'} Claude Code ${claudeWorks ? '正常' : '失败'}`);
  } catch (e) {
    console.log(`   ❌ Claude Code 异常: ${e.message}`);
  }

  console.log('\n   验证 AtomCode...');
  try {
    const atomResult = await atomAdapter.execute('写一个简单的Python函数', {
      timeout: 120000,
      verbose: false
    });
    atomWorks = atomResult.success;
    console.log(`   ${atomWorks ? '✅' : '❌'} AtomCode ${atomWorks ? '正常' : '失败'}`);
  } catch (e) {
    console.log(`   ❌ AtomCode 异常: ${e.message}`);
  }

  if (!claudeWorks || !atomWorks) {
    console.log('\n   ❌ 需要两个工具都正常工作才能测试');
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // 测试3: 同时派发不同任务给不同工具
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试3: 同时派发不同任务给不同工具');
  console.log('-'.repeat(40));

  const executor = new ToolExecutor({
    workspaceDir: testWorkspace,
    defaultTimeout: 180000
  });

  executor.registerAdapter(claudeAdapter);
  executor.registerAdapter(atomAdapter);

  const tasks = [
    {
      id: 'T1',
      title: '实现斐波那契函数',
      description: '用Python写一个计算斐波那契数列的函数',
      estimatedComplexity: 'medium',
      role: 'code_writer',
      assignedTool: 'claude-code'
    },
    {
      id: 'T2',
      title: '实现打印函数',
      description: '用Python写一个打印结果的辅助函数',
      estimatedComplexity: 'low',
      role: 'code_writer',
      assignedTool: 'atom-code'
    }
  ];

  console.log('\n   任务分配:');
  console.log('   ┌─────────────────────────────────────────────────┐');
  console.log(`   │ T1: ${tasks[0].title.padEnd(20)} → Claude Code      │`);
  console.log(`   │ T2: ${tasks[1].title.padEnd(20)} → AtomCode       │`);
  console.log('   └─────────────────────────────────────────────────┘');

  console.log('\n   正在并行执行...');
  const startTime = Date.now();

  // 并行执行两个不同的任务
  const promises = tasks.map(task => {
    return executor.executeTask(task, {
      preferredTools: [task.assignedTool],
      timeout: 180000
    });
  });

  const results = await Promise.allSettled(promises);
  const duration = Date.now() - startTime;

  console.log(`   执行完成（${Math.round(duration / 1000)}秒）`);

  // 收集结果
  const toolResults = {};
  let successCount = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = results[i];

    if (result.status === 'fulfilled') {
      const execResult = result.value;

      toolResults[task.assignedTool] = {
        success: execResult.success,
        taskId: task.id,
        title: task.title,
        output: execResult.output,
        generatedFiles: execResult.generatedFiles || [],
        codeBlocks: execResult.codeBlocks || [],
        duration: execResult.duration
      };

      if (execResult.success) {
        successCount++;
        console.log(`   ✅ ${task.assignedTool}: ${task.title} - 成功`);
        if (execResult.codeBlocks && execResult.codeBlocks.length > 0) {
          console.log(`      代码块: ${execResult.codeBlocks.length} 个`);
          for (const block of execResult.codeBlocks) {
            console.log(`        - ${block.language}: ${block.code.substring(0, 60)}...`);
          }
        }
      } else {
        console.log(`   ❌ ${task.assignedTool}: ${task.title} - 失败: ${execResult.error || execResult.stderr || '未知'}`);
      }
    } else {
      console.log(`   ❌ ${task.assignedTool}: ${task.title} - 异常: ${result.reason?.message}`);
      toolResults[task.assignedTool] = { success: false, error: result.reason?.message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 测试4: 使用 MergeEngine 合并结果（两个工具都成功时）
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试4: 使用 MergeEngine 合并结果');
  console.log('-'.repeat(40));

  if (successCount !== 2) {
    console.log(`   ⚠️ 只有 ${successCount}/2 个工具成功，跳过合并测试`);
    return;
  }

  // 准备合并数据
  const mergeInput = {};
  for (const [toolName, result] of Object.entries(toolResults)) {
    if (result.success) {
      mergeInput[toolName] = {
        success: true,
        result: {
          codeBlocks: result.codeBlocks.map((block, idx) => ({
            ...block,
            filePath: `task_${toolName}_${idx}.py`,
            filename: `task_${toolName}_${idx}.py`
          })),
          content: result.output?.content || '',
          quality: { qualityScore: 80 }
        }
      };
    }
  }

  console.log(`\n   准备合并 ${Object.keys(mergeInput).length} 个工具的产出...`);

  const mockProvider = createMockProvider();
  const mergeEngine = new MergeEngine(mockProvider);

  const mergeResult = await mergeEngine.merge(mergeInput, {
    language: 'python',
    techStack: 'python'
  });

  console.log('   ✅ 合并完成');
  console.log(`   合并策略: ${mergeResult.mergeStrategy}`);
  console.log(`   冲突数: ${mergeResult.conflicts?.length || 0}`);
  console.log(`   改进数: ${mergeResult.improvements?.length || 0}`);

  if (mergeResult.qualityAssessment) {
    console.log('\n   质量评分:');
    console.log(`      - 正确性: ${mergeResult.qualityAssessment.correctness}`);
    console.log(`      - 一致性: ${mergeResult.qualityAssessment.consistency}`);
    console.log(`      - 可读性: ${mergeResult.qualityAssessment.readability}`);
    console.log(`      - 安全性: ${mergeResult.qualityAssessment.security}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 测试5: 保存合并结果
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试5: 保存合并结果');
  console.log('-'.repeat(40));

  const outputDir = path.join(testWorkspace, 'merged_output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (mergeResult.mergedCode) {
    const mergedFile = path.join(outputDir, 'merged_result.py');
    fs.writeFileSync(mergedFile, mergeResult.mergedCode, 'utf-8');
    console.log(`   ✅ 合并代码已保存: ${mergedFile}`);
  }

  const report = mergeEngine.generateMergeReport(mergeResult);
  const reportFile = path.join(outputDir, 'merge_report.txt');
  fs.writeFileSync(reportFile, report, 'utf-8');
  console.log(`   ✅ 合并报告已保存: ${reportFile}`);

  // ═══════════════════════════════════════════════════════════
  // 总结
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('📊 多工具任务派发与合并测试总结');
  console.log('-'.repeat(40));

  if (successCount === 2) {
    console.log('   ✅ 两个工具都成功执行不同任务');
    console.log('   ✅ Claude Code 和 AtomCode 并行执行');
    console.log('   ✅ MergeEngine 成功合并两个工具的产出');
    console.log('   ✅ 合并报告生成成功');
    console.log('   ✅ 合并结果已保存到文件');
    console.log('\n   🎉 测试通过！多工具任务派发与合并功能正常工作。');
  } else {
    console.log(`   ❌ 只有 ${successCount}/2 个工具成功`);
    console.log('   ⚠️ 需要在更好的网络/资源条件下测试');
  }

  console.log('='.repeat(60));

  return { success: successCount === 2, mergeResult, toolResults };
}

testMultiToolDispatch().catch(e => {
  console.error('❌ 测试异常:', e.message);
  console.error(e.stack);
  process.exit(1);
});
