#!/usr/bin/env node
require('dotenv').config();

const OpenAIProvider = require('../src/providers/OpenAIProvider');

async function main () {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  if (!apiKey || apiKey === 'your-api-key') {
    console.log('❌ 请配置 DEEPSEEK_API_KEY 环境变量');
    process.exit(0);
  }

  const provider = new OpenAIProvider({
    apiKey,
    baseUrl,
    model
  });

  console.log(`\n🚀 测试 DeepSeek API (${model})`);
  console.log('='.repeat(50));

  try {
    const result = await provider.chat(
      [{ role: 'user', content: '用Python写一个函数计算两个数的最大公约数，只用代码块输出' }],
      { temperature: 0.7, maxTokens: 2000 }
    );

    console.log('\n✅ API调用成功!');
    console.log(`📝 返回内容: ${result.content.substring(0, 300)}...`);
    console.log(`📊 使用模型: ${result.model}`);

    if (result.usage) {
      console.log(`📈 Token使用: ${result.usage.prompt_tokens} prompt + ${result.usage.completion_tokens} completion = ${result.usage.total_tokens} total`);
    }
  } catch (e) {
    console.error('\n❌ API调用失败:', e.message);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('测试失败:', e);
  process.exit(1);
});
