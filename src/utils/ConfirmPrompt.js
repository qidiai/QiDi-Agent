/**
 * 用户确认工具模块
 * 
 * 用于在关键操作前获取用户确认
 * 支持 CLI 交互式确认和静默模式
 */

const readline = require('readline');

class ConfirmPrompt {
  constructor(options = {}) {
    this.silent = options.silent || false;  // 静默模式，不等待输入
    this.autoConfirm = options.autoConfirm || false;  // 自动确认所有
    this.defaultYes = options.defaultYes !== false;  // 默认选择是
  }

  /**
   * 创建 readline 接口
   */
  _createInterface() {
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  /**
   * 同步确认（用于静默模式）
   */
  sync(question, defaultChoice = true) {
    if (this.autoConfirm) {
      return true;
    }
    
    const choices = defaultChoice ? '[Y/n]' : '[y/N]';
    console.log(`  ${question} ${choices}: `);
    return defaultChoice;
  }

  /**
   * 异步确认（CLI 交互）
   */
  async confirm(question, defaultChoice = true) {
    if (this.silent || this.autoConfirm) {
      return this.defaultYes;
    }

    return new Promise((resolve) => {
      const rl = this._createInterface();
      const choices = defaultChoice ? 'Y/n' : 'y/N';
      const hint = defaultChoice ? 'Y' : 'N';
      
      rl.question(`  ⚠️ ${question} (${choices}): `, (answer) => {
        rl.close();
        
        if (!answer.trim()) {
          resolve(defaultChoice);
          return;
        }
        
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === 'y' || normalized === 'yes');
      });
    });
  }

  /**
   * 选择列表确认
   */
  async select(question, options, defaultIndex = 0) {
    if (this.silent || this.autoConfirm) {
      return defaultIndex;
    }

    console.log(`\n  📋 ${question}`);
    options.forEach((opt, i) => {
      const marker = i === defaultIndex ? '→' : ' ';
      console.log(`    ${marker} ${i + 1}. ${opt.label || opt.name || opt}`);
    });

    return new Promise((resolve) => {
      const rl = this._createInterface();
      
      rl.question(`  请选择 (1-${options.length}) [默认${defaultIndex + 1}]: `, (answer) => {
        rl.close();
        
        if (!answer.trim()) {
          resolve(defaultIndex);
          return;
        }
        
        const idx = parseInt(answer.trim(), 10) - 1;
        if (idx >= 0 && idx < options.length) {
          resolve(idx);
        } else {
          resolve(defaultIndex);
        }
      });
    });
  }

  /**
   * 显示工具调用确认
   */
  async confirmTools(tools) {
    if (!tools || tools.length === 0) {
      return { confirmed: false, reason: '没有可用的工具' };
    }

    console.log('\n' + '='.repeat(60));
    console.log('  🤖 将要调用的 AI 编程工具：');
    console.log('='.repeat(60));
    
    for (const tool of tools) {
      console.log(`    • ${tool.displayName || tool.name}`);
      if (tool.description) {
        console.log(`      ${tool.description}`);
      }
    }
    
    console.log('-'.repeat(60));
    console.log('  ⚠️  法律提示：');
    console.log('    • 请确保您已阅读并同意各工具的使用条款');
    console.log('    • 使用本工具产生的代码责任由您自负');
    console.log('    • 本项目不对任何法律问题负责');
    console.log('-'.repeat(60));

    const confirmed = await this.confirm('确认使用以上工具执行任务？', true);
    
    if (!confirmed) {
      console.log('  ❌ 已取消，任务不会执行');
      return { confirmed: false, reason: '用户取消' };
    }

    return { confirmed: true, tools };
  }

  /**
   * 显示隐私模式提示
   */
  async confirmPrivacyMode(mode) {
    console.log('\n' + '='.repeat(60));
    
    if (mode === 'privacy') {
      console.log('  🔒 隐私模式配置：');
      console.log('    • 任务拆分：本地 Ollama（代码不离开本地）');
      console.log('    • 质量检查：本地 Ollama 打分');
      console.log('    • 代码合并：契约拼装');
    } else {
      console.log('  ✨ 高质量模式配置：');
      console.log('    • 任务拆分：云端 API');
      console.log('    • 质量检查：云端 AI 打分');
      console.log('    • 代码合并：AI 智能合并');
    }
    
    console.log('='.repeat(60));

    const confirmed = await this.confirm('确认使用此模式执行任务？', true);
    return confirmed;
  }

  /**
   * 显示扫描结果确认
   */
  async confirmScanResults(results) {
    if (!results || results.length === 0) {
      console.log('  ℹ️  未发现任何 AI 编程工具');
      return { confirmed: false, enabled: [] };
    }

    console.log('\n' + '='.repeat(60));
    console.log('  🔍 扫描到以下 AI 编程工具：');
    console.log('='.repeat(60));
    
    const enabled = [];
    
    for (const tool of results) {
      console.log(`\n    ${tool.icon || '•'} ${tool.name} (${tool.displayName || tool.name})`);
      if (tool.version) {
        console.log(`       版本: ${tool.version}`);
      }
      if (tool.path) {
        console.log(`       路径: ${tool.path}`);
      }
      
      if (this.silent || this.autoConfirm) {
        enabled.push(tool);
        console.log('       → 将被启用（自动模式）');
      } else {
        const confirm = await this.confirm(`启用 ${tool.displayName || tool.name}？`, true);
        if (confirm) {
          enabled.push(tool);
          console.log('       → ✅ 已启用');
        } else {
          console.log('       → ⏭️  已跳过');
        }
      }
    }

    console.log('\n' + '-'.repeat(60));
    console.log(`  📊 共扫描到 ${results.length} 个工具，启用 ${enabled.length} 个`);
    console.log('-'.repeat(60));

    return { confirmed: enabled.length > 0, enabled };
  }
}

module.exports = ConfirmPrompt;
