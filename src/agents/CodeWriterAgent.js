const BaseAgent = require('./BaseAgent');

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
对每个文件使用独立的代码块，每个代码块第一行必须以 "// 文件路径:" 或 "# 文件路径:" 开头：
\`\`\`c
// 文件路径: src/main.c
#include <stdio.h>
int main() { return 0; }
\`\`\`

\`\`\`c
// 文件路径: src/utils.h
#ifndef UTILS_H
#define UTILS_H
#endif
\`\`\`

【JSON结构化输出（推荐）】
当输出多个文件时，优先使用 JSON 格式：
{
  "files": [
    {
      "filePath": "src/main.c",
      "language": "c",
      "code": "#include <stdio.h>\\nint main() { return 0; }"
    },
    {
      "filePath": "src/utils.h",
      "language": "c",
      "code": "#ifndef UTILS_H\\n#define UTILS_H\\n#endif"
    }
  ],
  "summary": "简要说明本次实现的内容"
}

注意：
- 必须明确标注每个文件的路径
- 代码必须完整可运行
- 遵循指定的编程语言约束`;

class CodeWriterAgent extends BaseAgent {
  constructor (provider, options = {}) {
    super(provider, {
      name: 'CodeWriter',
      role: '代码工程师',
      systemPrompt: CODE_WRITER_PROMPT,
      temperature: 0.7,
      ...options
    });
  }

  async writeCode (task, context = {}, options = {}) {
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

    if (context.qualityFeedback) {
      prompt += `\n【⚠️ 上次质检反馈】\n评分：${context.qualityFeedback.score || '?'}分\n问题：${context.qualityFeedback.suggestions || context.qualityFeedback.issues?.join('; ') || '无'}\n请根据反馈修改代码！\n`;
    }

    if (context.previousCode) {
      prompt += '\n【前置任务代码】\n以下是之前任务已经完成的代码，请在此基础上继续开发：\n';
      prompt += `${context.previousCode.substring(0, 3000)}\n`;
    }

    if (context.projectInfo) {
      prompt += `\n项目背景：\n${context.projectInfo}\n`;
    }

    if (context.existingCode) {
      prompt += `\n现有相关代码：\n${context.existingCode.substring(0, 2000)}\n`;
    }

    if (context.fileStructure) {
      prompt += `\n文件结构参考：\n${context.fileStructure}\n`;
    }

    prompt += '\n【输出要求】\n请按照规范格式输出代码。如果涉及多个文件，请明确标注每个文件的路径。\n对于 C 语言，请提供完整的可编译代码。';

    const result = await this.sendOnce(prompt, options);
    const codeBlocks = this._extractCodeBlocks(result.content);

    return {
      content: result.content,
      codeBlocks,
      hasMultipleFiles: codeBlocks.length > 1,
      model: result.model || 'unknown'
    };
  }

  _extractCodeBlocks (text) {
    const blocks = [];

    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        const jsonData = JSON.parse(jsonMatch[1]);
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

    const jsonDirectMatch = text.match(/\{[\s\S]*"files"\s*:/);
    if (jsonDirectMatch) {
      try {
        const braceStart = text.indexOf('{');
        const braceEnd = text.lastIndexOf('}');
        if (braceStart !== -1 && braceEnd !== -1) {
          const jsonData = JSON.parse(text.substring(braceStart, braceEnd + 1));
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

    const regex = /```(\w+)?\s*\n([\s\S]*?)\n```/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const language = match[1] || 'text';
      const code = match[2];

      const filePathMatch = code.match(/^(\/\/|#)\s*文件路径\s*[:=]\s*(\S+)/m);
      const filePath = filePathMatch ? filePathMatch[2] : `file_${blocks.length + 1}`;

      const cleanCode = code.replace(/^(\/\/|#)\s*文件路径\s*[:=]\s*\S+\s*/m, '').trim();

      blocks.push({
        filePath,
        language,
        code: cleanCode
      });
    }

    if (blocks.length === 0 && text.trim()) {
      blocks.push({
        filePath: 'main',
        language: 'text',
        code: text.trim()
      });
    }

    return blocks;
  }

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

    return {
      content: result.content,
      codeBlocks,
      hasMultipleFiles: codeBlocks.length > 1,
      model: result.model || 'unknown',
      refinementApplied: true
    };
  }
}

module.exports = CodeWriterAgent;
