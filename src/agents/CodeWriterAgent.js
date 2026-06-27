const BaseAgent = require('./BaseAgent');

const CODE_WRITER_PROMPT = '你是一位经验丰富的软件工程师，精通多种编程语言，包括 C、C++、Java、Python、JavaScript 等。\n\n你的职责：\n1. 仔细理解任务需求\n2. 编写清晰、规范、有注释的代码\n3. 遵循最佳实践和设计模式\n4. 考虑边界情况和错误处理\n5. 保持代码的可读性和可维护性\n6. 对于编译型语言（C/C++/Java），请提供完整的项目结构，包括头文件和源文件\n7. 对于 C 语言，请包含必要的头文件（stdio.h、stdlib.h、string.h 等）和主函数\n8. 对于 C++，请使用现代 C++ 特性，包含必要的命名空间和头文件\n\n输出代码时使用 ```语言 代码块 格式。\n如果你需要创建或修改多个文件，请明确标注每个文件的路径和内容。';


class CodeWriterAgent extends BaseAgent {
  constructor(provider, options = {}) {
    super(provider, {
      name: 'CodeWriter',
      role: '代码工程师',
      systemPrompt: CODE_WRITER_PROMPT,
      temperature: 0.7,
      ...options
    });
  }

  async writeCode(task, context = {}) {
    let prompt = `请完成以下编程任务：\n\n任务：${task.title}\n描述：${task.description}\n`;

    if (context.constraints) {
      prompt += `\n【全局约束】\n`;
      prompt += `编程语言：${context.constraints.language || '未指定'}\n`;
      prompt += `技术栈：${context.constraints.techStack || '未指定'}\n`;
      prompt += `平台：${context.constraints.platform || '未指定'}\n`;
      prompt += `框架：${context.constraints.framework || 'None'}\n`;
      prompt += `代码风格：${context.constraints.style || 'standard'}\n`;
      prompt += `\n⚠️ 必须严格遵守以上约束，不得使用其他编程语言或技术栈！\n`;
    }

    if (context.previousCode) {
      prompt += `\n【前置任务代码】\n以下是之前任务已经完成的代码，请在此基础上继续开发：\n`;
      prompt += `${context.previousCode}\n`;
    }

    if (context.projectInfo) {
      prompt += `\n项目背景：\n${context.projectInfo}\n`;
    }

    if (context.existingCode) {
      prompt += `\n现有相关代码：\n${context.existingCode}\n`;
    }

    if (context.fileStructure) {
      prompt += `\n文件结构参考：\n${context.fileStructure}\n`;
    }

    prompt += `\n请提供完整的代码实现，包括必要的说明。`;

    const result = await this.sendOnce(prompt);
    return {
      content: result.content,
      codeBlocks: this._extractCodeBlocks(result.content)
    };
  }

  _extractCodeBlocks(text) {
    const blocks = [];
    const regex = /```(\w+)?\s*\n([\s\S]*?)\n```/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      blocks.push({
        language: match[1] || 'text',
        code: match[2]
      });
    }

    return blocks;
  }
}

module.exports = CodeWriterAgent;
