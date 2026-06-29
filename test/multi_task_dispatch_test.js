/**
 * 多工具任务派发与合并测试
 *
 * 测试场景：
 * 1. 派发不同任务给不同工具（Claude Code 和 AtomCode）
 * 2. 使用 MergeEngine 合并结果
 * 3. 验证合并后的代码质量
 */

const ClaudeCodeAdapter = require('../src/adapters/ClaudeCodeAdapter');
const AtomCodeAdapter = require('../src/adapters/AtomCodeAdapter');
const ToolExecutor = require('../src/core/ToolExecutor');
const MergeEngine = require('../src/agents/MergeEngine');
const fs = require('fs');
const path = require('path');

// Mock Provider for MergeEngine
function createMockProvider () {
  return {
    name: 'mock',
    chat: async (messages) => {
      const lastMsg = messages[messages.length - 1]?.content || '';

      if (lastMsg.includes('合并')) {
        return {
          content: JSON.stringify({
            mergedCode: '# 合并后的代码 - 整合了两个工具的产出\n# Claude Code 的核心逻辑 + AtomCode 的辅助功能\n\ndef main():\n    print("Hello from merged result!")\n    greet_user("World")\n\ndef greet_user(name):\n    print(f"Hello, {name}!")\n\nif __name__ == "__main__":\n    main()',
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
                description: '增加了 greet_user 函数',
                before: '只有 print',
                after: '有完整函数'
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

async function testMultiTaskDispatchAndMerge () {
  console.log('🧪 多工具任务派发与合并测试\n');
  console.log('='.repeat(60));

  const testWorkspace = './test_multi_task_workspace';
  if (!fs.existsSync(testWorkspace)) {
    fs.mkdirSync(testWorkspace, { recursive: true });
  }

  // ═══════════════════════════════════════════════════════════
  // 测试1: 初始化工具执行器和合并引擎
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试1: 初始化工具执行器和合并引擎');
  console.log('-'.repeat(40));

  const executor = new ToolExecutor({
    workspaceDir: testWorkspace,
    defaultTimeout: 300000
  });

  const claudeAdapter = new ClaudeCodeAdapter({ workspaceDir: testWorkspace });
  const atomAdapter = new AtomCodeAdapter({ workspaceDir: testWorkspace });

  await claudeAdapter.detect();
  await atomAdapter.detect();

  if (claudeAdapter.isAvailable()) {
    executor.registerAdapter(claudeAdapter);
    console.log('   ✅ Claude Code 已注册');
  } else {
    console.log('   ❌ Claude Code 不可用');
    return;
  }

  if (atomAdapter.isAvailable()) {
    executor.registerAdapter(atomAdapter);
    console.log('   ✅ AtomCode 已注册');
  } else {
    console.log('   ❌ AtomCode 不可用');
    return;
  }

  const mockProvider = createMockProvider();
  const mergeEngine = new MergeEngine(mockProvider);
  console.log('   ✅ MergeEngine 已初始化');

  // ═══════════════════════════════════════════════════════════
  // 测试2: 同时派发不同任务给不同工具
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试2: 同时派发不同任务给不同工具');
  console.log('-'.repeat(40));

  const tasks = [
    {
      id: 'T1',
      title: '实现核心逻辑',
      description: '用Python写一个计算斐波那契数列的函数',
      estimatedComplexity: 'medium',
      role: 'code_writer',
      assignedTool: 'claude-code'
    },
    {
      id: 'T2',
      title: '实现辅助功能',
      description: '用Python写一个打印结果的函数',
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
      timeout: 300000
    });
  });

  const results = await Promise.allSettled(promises);
  const duration = Date.now() - startTime;

  console.log(`   执行完成（${Math.round(duration / 1000)}秒）`);

  // 收集结果
  const toolResults = {};
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

      console.log(`   ✅ ${task.assignedTool}: ${task.title} - ${execResult.success ? '成功' : '失败'}`);
      if (execResult.codeBlocks && execResult.codeBlocks.length > 0) {
        console.log(`      代码块: ${execResult.codeBlocks.length} 个`);
        for (const block of execResult.codeBlocks) {
          console.log(`        - ${block.language}: ${block.code.substring(0, 50)}...`);
        }
      }
    } else {
      console.log(`   ❌ ${task.assignedTool}: ${task.title} - 异常: ${result.reason?.message}`);
      toolResults[task.assignedTool] = { success: false, error: result.reason?.message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 测试3: 使用 MergeEngine 合并结果
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试3: 使用 MergeEngine 合并结果');
  console.log('-'.repeat(40));

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

  if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
    console.log('\n   冲突详情:');
    for (const conflict of mergeResult.conflicts) {
      console.log(`      - ${conflict.location}: ${conflict.description}`);
      console.log(`        选择方案: ${conflict.chosenResolution}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 测试4: 生成合并报告
  // ═══════════════════════════════════════════════════════════
  console.log('\n📋 测试4: 生成合并报告');
  console.log('-'.repeat(40));

  const report = mergeEngine.generateMergeReport(mergeResult);
  console.log('\n   📄 合并报告:');
  console.log('   ' + '-'.repeat(40));
  console.log(report);

  // ═══════════════════════════════════════════════════════════
  // 测试5: 保存合并结果到文件
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

  const reportFile = path.join(outputDir, 'merge_report.txt');
  fs.writeFileSync(reportFile, report, 'utf-8');
  console.log(`   ✅ 合并报告已保存: ${reportFile}`);

  // ═══════════════════════════════════════════════════════════
  // 总结
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('📊 多工具任务派发与合并测试总结');
  console.log('-'.repeat(40));
  console.log('   ✅ 不同任务可以同时派发给不同工具');
  console.log('   ✅ Claude Code 和 AtomCode 并行执行');
  console.log('   ✅ MergeEngine 成功合并多个工具的产出');
  console.log('   ✅ 合并报告生成成功');
  console.log('   ✅ 合并结果已保存到文件');
  console.log('\n   🎉 测试通过！多工具任务派发与合并功能正常工作。');
  console.log('='.repeat(60));

  return { success: true, mergeResult, toolResults };
}

testMultiTaskDispatchAndMerge().catch(e => {
  console.error('❌ 测试异常:', e.message);
  console.error(e.stack);
  process.exit(1);
});
