const BaseAgent = require('./BaseAgent');
const { safeExtractJson, safeJsonParse } = require('../utils/SafeParser');
const logger = require('../utils/Logger')('CodeWriterAgent');

const CODE_WRITER_PROMPT = `你是一位经验丰富的软件工程师，精通多种编程语言，包括 C、C++、Java、Python、JavaScript 等。

你的职责：
1. 仔细理解任务需求
2. 编写清晰、规范、有注释的代码
3. 遵循最佳实践和设计模式
4. 考虑边界情况和错误处理
5. 保持代码的可读性和可维护性
6. 对于编译型语言（C/C++/Java），请提供完整的项目结构，包括头文件和源文件
7. 对于 C 语言，请包含必要的头文件（stdio.h、stdlib.h、string.h 等）和主函数
8. 对于 C++，请使用现代 C++ 特性，包含必要的命名空间和头文件

输出格式规范（必须严格遵守）：

【单文件输出】
使用标准代码块格式：
\`\`\`language
// 文件路径: /path/to/file.ext
代码内容
\`\`\`

【多文件输出】
对每个文件使用独立的代码块，每个代码块第一行必须以 "// 文件路径:" 或 "# 文件路径:" 开头。

【JSON结构化输出（推荐）】
{
  "files": [{"filePath": "src/main.c", "language": "c", "code": "..."}],
  "summary": "简要说明本次实现的内容"
}

注意：
- 必须明确标注每个文件的路径
- 代码必须完整可运行
- 遵循指定的编程语言约束`;

// ── 代码模板库 ──

const CODE_TEMPLATES = {
  c: {
    main: '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n\n// {{DESCRIPTION}}\n\nint main(int argc, char *argv[]) {\n    // TODO: 实现主要逻辑\n    return 0;\n}\n',
    header: '#ifndef {{GUARD}}\n#define {{GUARD}}\n\n// {{DESCRIPTION}}\n\n// 函数声明\n\n#endif // {{GUARD}}\n',
    lib: '#include "{{HEADER}}"\n\n// 函数实现\n'
  },
  cpp: {
    main: '#include <iostream>\n#include <vector>\n#include <string>\n\nusing namespace std;\n\n// {{DESCRIPTION}}\n\nint main() {\n    // TODO: 实现主要逻辑\n    return 0;\n}\n',
    header: '#pragma once\n\n#include <iostream>\n#include <vector>\n#include <string>\n\nusing namespace std;\n\n// {{DESCRIPTION}}\n\n// 类/函数声明\n',
    class: '// {{DESCRIPTION}}\nclass {{CLASS_NAME}} {\npublic:\n    {{CLASS_NAME}}();\n    ~{{CLASS_NAME}}();\n\nprivate:\n    // 私有成员\n};\n'
  },
  python: {
    main: '#!/usr/bin/env python3\n"""{{DESCRIPTION}}"""\n\nimport sys\nimport os\n\n\ndef main():\n    """主函数"""\n    # TODO: 实现主要逻辑\n    pass\n\n\nif __name__ == \'__main__\':\n    main()\n',
    module: '"""{{DESCRIPTION}}"""\n\nimport logging\n\nlogger = logging.getLogger(__name__)\n\n\n# 类/函数定义\n',
    test: '#!/usr/bin/env python3\n"""测试文件: {{DESCRIPTION}}"""\n\nimport pytest\n\n\nclass Test{{CLASS_NAME}}:\n    def setup_method(self):\n        pass\n\n    def test_basic(self):\n        pass\n'
  },
  javascript: {
    main: '\'use strict\';\n\n// {{DESCRIPTION}}\n\nfunction main() {\n  // TODO: 实现主要逻辑\n}\n\nmain();\n',
    module: '\'use strict\';\n\n// {{DESCRIPTION}}\n\nmodule.exports = {\n  // 导出的函数/对象\n};\n',
    class: '\'use strict\';\n\n// {{DESCRIPTION}}\nclass {{CLASS_NAME}} {\n  constructor() {\n    // 初始化\n  }\n\n  // 方法\n}\n\nmodule.exports = {{CLASS_NAME}};\n',
    test: '\'use strict\';\n\n// 测试: {{DESCRIPTION}}\n\ndescribe(\'{{CLASS_NAME}}\', () => {\n  test(\'基本功能\', () => {\n    // TODO: 测试逻辑\n  });\n});\n'
  },
  typescript: {
    main: '// {{DESCRIPTION}}\n\nfunction main(): void {\n  // TODO: 实现主要逻辑\n}\n\nmain();\n',
    module: '// {{DESCRIPTION}}\n\nexport interface I{{CLASS_NAME}} {\n  // 接口定义\n}\n\nexport class {{CLASS_NAME}} implements I{{CLASS_NAME}} {\n  constructor() {}\n}\n',
    test: '// 测试: {{DESCRIPTION}}\n\nimport { {{CLASS_NAME}} } from \'./module\';\n\ndescribe(\'{{CLASS_NAME}}\', () => {\n  test(\'基本功能\', () => {\n    // TODO\n  });\n});\n'
  },
  go: {
    main: 'package main\n\nimport (\n\t"fmt"\n)\n\n// {{DESCRIPTION}}\nfunc main() {\n\t// TODO: 实现主要逻辑\n\tfmt.Println("Hello, World!")\n}\n',
    module: 'package {{PACKAGE}}\n\n// {{DESCRIPTION}}\n\n// 函数定义\n',
    test: 'package {{PACKAGE}}\n\nimport "testing"\n\nfunc Test{{CLASS_NAME}}(t *testing.T) {\n\t// TODO: 测试逻辑\n}\n'
  },
  java: {
    main: '// {{DESCRIPTION}}\npublic class Main {\n    public static void main(String[] args) {\n        // TODO: 实现主要逻辑\n    }\n}\n',
    class: '// {{DESCRIPTION}}\npublic class {{CLASS_NAME}} {\n    public {{CLASS_NAME}}() {\n        // 构造函数\n    }\n}\n',
    test: 'import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\n\n// 测试: {{DESCRIPTION}}\nclass {{CLASS_NAME}}Test {\n    @Test\n    void testBasic() {\n        // TODO\n    }\n}\n'
  },
  rust: {
    main: '// {{DESCRIPTION}}\n\nfn main() {\n    // TODO: 实现主要逻辑\n    println!("Hello, World!");\n}\n',
    module: '// {{DESCRIPTION}}\n\npub fn {{FUNCTION_NAME}}() {\n    // TODO\n}\n',
    test: '#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn test_basic() {\n        // TODO\n    }\n}\n'
  }
};

class CodeWriterAgent extends BaseAgent {
  constructor (provider, options = {}) {
    super(provider, {
      name: 'CodeWriter',
      role: '代码工程师',
      systemPrompt: CODE_WRITER_PROMPT,
      temperature: 0.7,
      enableStructuredOutput: false,
      ...options
    });
    this.templates = CODE_TEMPLATES;
    this.enableSelfCheck = options.enableSelfCheck !== false;
    this.maxSelfCheckRounds = options.maxSelfCheckRounds || 2;
    this.enableIncremental = options.enableIncremental !== false;
    this._generationHistory = [];
  }

  /**
   * 获取代码模板
   */
  getTemplate (language, type = 'main', vars = {}) {
    const langTemplates = this.templates[language?.toLowerCase()];
    if (!langTemplates || !langTemplates[type]) return null;

    let template = langTemplates[type];
    for (const [key, value] of Object.entries(vars)) {
      template = template.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return template;
  }

  /**
   * 智能代码生成（含自检和多轮修正）
   */
  async writeCode (task, context = {}, options = {}) {
    // 1. 构建增强上下文
    const enhancedContext = this._enhanceContext(context);

    // 2. 检测是否为增量生成场景
    const isIncremental = this.enableIncremental && (context.existingCode || context.previousCode);

    // 3. 构建prompt
    const prompt = this._buildPrompt(task, enhancedContext, isIncremental);

    // 4. 生成代码
    const result = await this.sendOnce(prompt, options);
    let codeBlocks = this._extractCodeBlocks(result.content);

    // 5. 自检循环
    if (this.enableSelfCheck && codeBlocks.length > 0) {
      for (let round = 0; round < this.maxSelfCheckRounds; round++) {
        const selfCheckResult = this._selfCheck(codeBlocks, task, enhancedContext);
        if (selfCheckResult.passed) break;

        logger.info(`[CodeWriter] 自检第${round + 1}轮: 发现${selfCheckResult.issues.length}个问题，修正中...`);
        const fixResult = await this._selfCorrect(task, codeBlocks, selfCheckResult.issues, enhancedContext);
        codeBlocks = fixResult.codeBlocks || codeBlocks;
      }
    }

    // 6. 记录生成历史
    this._generationHistory.push({
      timestamp: Date.now(),
      taskTitle: task.title,
      language: enhancedContext.constraints?.language,
      fileCount: codeBlocks.length,
      isIncremental
    });
    if (this._generationHistory.length > 100) this._generationHistory.shift();

    return {
      content: result.content,
      codeBlocks,
      hasMultipleFiles: codeBlocks.length > 1,
      model: result.model || 'unknown',
      selfChecked: this.enableSelfCheck,
      incremental: isIncremental
    };
  }

  /**
   * 增强上下文：注入模板、历史经验
   */
  _enhanceContext (context) {
    const enhanced = { ...context };

    // 注入代码模板提示
    if (context.constraints?.language) {
      const lang = context.constraints.language.toLowerCase();
      const availableTemplates = this.templates[lang];
      if (availableTemplates) {
        enhanced.templateHint = `可用模板: ${Object.keys(availableTemplates).join(', ')}`;
      }
    }

    // 注入历史生成经验
    if (this._generationHistory.length > 0) {
      const recentGens = this._generationHistory.slice(-5);
      const langCounts = {};
      for (const gen of recentGens) {
        if (gen.language) langCounts[gen.language] = (langCounts[gen.language] || 0) + 1;
      }
      enhanced.generationExperience = `最近生成: ${recentGens.length}次, 主要语言: ${Object.entries(langCounts).map(([k, v]) => `${k}(${v})`).join(', ')}`;
    }

    return enhanced;
  }

  /**
   * 构建增强 prompt
   */
  _buildPrompt (task, context, isIncremental) {
    let prompt = `请完成以下编程任务：\n\n任务：${task.title}\n描述：${task.description}\n`;

    if (task.acceptanceCriteria) {
      prompt += `\n【验收标准】\n${Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.join('\n') : task.acceptanceCriteria}\n`;
    }

    if (context.constraints) {
      prompt += '\n【全局约束】\n';
      prompt += `编程语言：${context.constraints.language || '未指定'}\n`;
      prompt += `技术栈：${context.constraints.techStack || '未指定'}\n`;
      prompt += `平台：${context.constraints.platform || '未指定'}\n`;
      prompt += `框架：${context.constraints.framework || 'None'}\n`;
      prompt += `代码风格：${context.constraints.style || 'standard'}\n`;
      prompt += '\n⚠️ 必须严格遵守以上约束，不得使用其他编程语言或技术栈！\n';
    }

    if (context.templateHint) {
      prompt += `\n【代码模板提示】${context.templateHint}\n`;
    }

    if (context.qualityFeedback) {
      prompt += `\n【⚠️ 上次质检反馈】\n评分：${context.qualityFeedback.score || '?'}分\n问题：${context.qualityFeedback.suggestions || context.qualityFeedback.issues?.join('; ') || '无'}\n请根据反馈修改代码！\n`;
    }

    if (isIncremental) {
      prompt += '\n【⚠️ 增量生成模式】\n';
      prompt += '已有代码如下，请在此基础上增量开发，保留已有代码的正确部分，只添加或修改必要的部分：\n';
      if (context.previousCode) {
        prompt += `\n【前置任务代码】\n${context.previousCode.substring(0, 3000)}\n`;
      }
      if (context.existingCode) {
        prompt += `\n【现有相关代码】\n${context.existingCode.substring(0, 2000)}\n`;
      }
    } else if (context.previousCode) {
      prompt += '\n【前置任务代码】\n以下是之前任务已经完成的代码，请在此基础上继续开发：\n';
      prompt += `${context.previousCode.substring(0, 3000)}\n`;
    }

    if (context.projectInfo) {
      prompt += `\n项目背景：\n${context.projectInfo}\n`;
    }

    if (context.fileStructure) {
      prompt += `\n文件结构参考：\n${context.fileStructure}\n`;
    }

    if (context.generationExperience) {
      prompt += `\n【经验参考】${context.generationExperience}\n`;
    }

    prompt += '\n【输出要求】\n请按照规范格式输出代码。如果涉及多个文件，请明确标注每个文件的路径。\n对于 C 语言，请提供完整的可编译代码。';

    return prompt;
  }

  /**
   * 自检：检查生成的代码是否有明显问题
   */
  _selfCheck (codeBlocks, task, context) {
    const issues = [];

    for (const block of codeBlocks) {
      const code = block.code || '';

      // 1. 空代码检查
      if (code.trim().length === 0) {
        issues.push({ file: block.filePath, type: 'empty', severity: 'critical', message: '代码为空' });
        continue;
      }

      // 2. TODO 占位检查
      const todoCount = (code.match(/TODO|FIXME|HACK/gi) || []).length;
      if (todoCount > 3) {
        issues.push({ file: block.filePath, type: 'todo_excess', severity: 'medium', message: `包含${todoCount}个TODO/FIXME` });
      }

      // 3. 语言匹配检查
      const expectedLang = context.constraints?.language?.toLowerCase();
      if (expectedLang) {
        const langPatterns = {
          python: /def\s+\w+|import\s+\w+|from\s+\w+\s+import/,
          javascript: /function\s+\w+|const\s+\w+|require\(|module\.exports/,
          typescript: /:\s*(string|number|boolean|void)\b|interface\s+\w+/,
          c: /#include\s*[<"]|int\s+main\s*\(/,
          cpp: /#include\s*[<"]|using\s+namespace|class\s+\w+/,
          go: /package\s+\w+|func\s+\w+|import\s+\(/,
          java: /public\s+class\s+\w+|import\s+java\./,
          rust: /fn\s+\w+|use\s+\w+|pub\s+fn/
        };
        const pattern = langPatterns[expectedLang];
        if (pattern && !pattern.test(code)) {
          issues.push({ file: block.filePath, type: 'language_mismatch', severity: 'high', message: `代码可能不符合${expectedLang}语言规范` });
        }
      }

      // 4. 基本语法检查（括号匹配）
      const openBraces = (code.match(/{/g) || []).length;
      const closeBraces = (code.match(/}/g) || []).length;
      if (openBraces !== closeBraces) {
        issues.push({ file: block.filePath, type: 'syntax', severity: 'high', message: `大括号不匹配: ${openBraces}个{ vs ${closeBraces}个}` });
      }

      const openParens = (code.match(/\(/g) || []).length;
      const closeParens = (code.match(/\)/g) || []).length;
      if (openParens !== closeParens) {
        issues.push({ file: block.filePath, type: 'syntax', severity: 'high', message: `圆括号不匹配: ${openParens}个( vs ${closeParens}个)` });
      }

      // 5. 函数完整性检查（C/Java 需要main函数）
      if (expectedLang === 'c' || expectedLang === 'java') {
        if (!code.includes('main')) {
          issues.push({ file: block.filePath, type: 'missing_main', severity: 'medium', message: '未找到main函数' });
        }
      }
    }

    const criticalIssues = issues.filter(i => i.severity === 'critical');
    const highIssues = issues.filter(i => i.severity === 'high');
    const passed = criticalIssues.length === 0 && highIssues.length === 0;

    return { passed, issues, criticalCount: criticalIssues.length, highCount: highIssues.length };
  }

  /**
   * 自我修正
   */
  async _selfCorrect (task, codeBlocks, issues, context) {
    const issuesSummary = issues.map(i => `- [${i.severity}] ${i.file}: ${i.message}`).join('\n');

    let prompt = `请修正以下代码中的问题：\n\n任务：${task.title}\n\n`;
    prompt += `【发现问题】\n${issuesSummary}\n\n`;
    prompt += '【当前代码】\n';

    for (const block of codeBlocks) {
      prompt += `\`\`\`${block.language || ''}\n// 文件路径: ${block.filePath}\n${block.code}\n\`\`\`\n`;
    }

    prompt += '\n请修正上述问题，输出完整的修正后代码。保留正确的部分，只修改有问题的部分。';

    const result = await this.sendOnce(prompt);
    return {
      content: result.content,
      codeBlocks: this._extractCodeBlocks(result.content)
    };
  }

  _extractCodeBlocks (text) {
    const blocks = [];

    // JSON 格式
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        const jsonData = safeJsonParse(jsonMatch[1], null);
        if (jsonData.files && Array.isArray(jsonData.files)) {
          for (const file of jsonData.files) {
            blocks.push({
              filePath: file.filePath || file.path || `file_${blocks.length + 1}`,
              language: file.language || 'text',
              code: file.code || ''
            });
          }
          return blocks;
        }
      } catch (e) {}
    }

    // 直接 JSON
    const jsonDirectMatch = text.match(/\{[\s\S]*"files"\s*:/);
    if (jsonDirectMatch) {
      try {
        const braceStart = text.indexOf('{');
        const braceEnd = text.lastIndexOf('}');
        if (braceStart !== -1 && braceEnd !== -1) {
          const jsonData = safeJsonParse(text.substring(braceStart, braceEnd + 1), null);
          if (jsonData.files && Array.isArray(jsonData.files)) {
            for (const file of jsonData.files) {
              blocks.push({
                filePath: file.filePath || file.path || `file_${blocks.length + 1}`,
                language: file.language || 'text',
                code: file.code || ''
              });
            }
            return blocks;
          }
        }
      } catch (e) {}
    }

    // 代码块格式
    const regex = /```(\w+)?\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const language = match[1] || 'text';
      const code = match[2];
      const filePathMatch = code.match(/^(\/\/|#)\s*文件路径\s*[:=]\s*(\S+)/m);
      const filePath = filePathMatch ? filePathMatch[2] : `file_${blocks.length + 1}`;
      const cleanCode = code.replace(/^(\/\/|#)\s*文件路径\s*[:=]\s*\S+\s*/m, '').trim();
      blocks.push({ filePath, language, code: cleanCode });
    }

    if (blocks.length === 0 && text.trim()) {
      blocks.push({ filePath: 'main', language: 'text', code: text.trim() });
    }

    return blocks;
  }

  /**
   * 精修代码（根据质检反馈）
   */
  async refineCode (task, originalCode, feedback, context = {}, options = {}) {
    let prompt = `请根据以下反馈精修代码：\n\n任务：${task.title}\n`;

    if (context.constraints) {
      prompt += `\n【约束】\n编程语言：${context.constraints.language || '未指定'}\n`;
    }

    prompt += `\n【原始代码】\n\`\`\`${task.language || 'text'}\n${originalCode}\n\`\`\`\n`;

    prompt += '\n【质检反馈】\n';
    if (feedback.revisionSuggestions) {
      prompt += `修改建议：${feedback.revisionSuggestions}\n`;
    }
    if (feedback.weaknesses && feedback.weaknesses.length > 0) {
      prompt += `问题列表：\n${feedback.weaknesses.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n`;
    }
    if (feedback.constraintViolations && feedback.constraintViolations.length > 0) {
      prompt += `约束违规：\n${feedback.constraintViolations.map((v, i) => `${i + 1}. ${v}`).join('\n')}\n`;
    }

    prompt += '\n【输出要求】请输出完整的修改后的代码（不是 diff 格式），确保修复了上述所有问题。保留原有正确的部分，只修改有问题的部分。';

    const result = await this.sendOnce(prompt, options);
    const codeBlocks = this._extractCodeBlocks(result.content);

    // 精修后也进行自检
    if (this.enableSelfCheck && codeBlocks.length > 0) {
      const selfCheckResult = this._selfCheck(codeBlocks, task, context);
      if (!selfCheckResult.passed) {
        const fixResult = await this._selfCorrect(task, codeBlocks, selfCheckResult.issues, context);
        if (fixResult.codeBlocks?.length > 0) {
          return {
            content: fixResult.content,
            codeBlocks: fixResult.codeBlocks,
            hasMultipleFiles: fixResult.codeBlocks.length > 1,
            model: result.model || 'unknown',
            refinementApplied: true,
            selfChecked: true
          };
        }
      }
    }

    return {
      content: result.content,
      codeBlocks,
      hasMultipleFiles: codeBlocks.length > 1,
      model: result.model || 'unknown',
      refinementApplied: true,
      selfChecked: this.enableSelfCheck
    };
  }

  /**
   * 获取生成统计
   */
  getStats () {
    return {
      totalGenerations: this._generationHistory.length,
      recentGenerations: this._generationHistory.slice(-10),
      languages: this._generationHistory.reduce((acc, h) => {
        if (h.language) acc[h.language] = (acc[h.language] || 0) + 1;
        return acc;
      }, {})
    };
  }
}

module.exports = CodeWriterAgent;
