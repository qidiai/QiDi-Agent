class TaskClassifier {
  constructor () {
    this.greetingPatterns = [
      /^(你好|hello|hi|hey|哈喽|你好呀|嗨|早上好|下午好|晚上好|good morning|good afternoon|good evening)$/i,
      /^(很高兴认识你|认识你很高兴|nice to meet you)$/i,
      /^(你是谁|你叫什么|who are you|what is your name)$/i,
      /^(你能做什么|你会做什么|what can you do)$/i,
      /^(再见|拜拜|bye|goodbye|see you)$/i,
      /^(谢谢|thanks|thank you)$/i
    ];

    this.programmingKeywords = [
      '写', '编写', '实现', '开发', '创建', '生成',
      '代码', 'program', 'code', 'develop', 'build', 'create',
      '函数', '方法', '类', 'interface', 'function', 'method', 'class',
      '网站', '网页', 'web', 'server', 'api', 'app',
      '游戏', 'game', 'snake', 'tetris', '贪吃蛇',
      '爬虫', 'crawler', 'scraper',
      '脚本', 'script',
      '测试', 'test', '单元测试', 'unittest',
      '修复', 'bug', 'fix', 'debug',
      '优化', 'optimize', 'refactor', '重构',
      'python', 'javascript', 'java', 'go', 'rust', 'c++', 'cpp', 'c#',
      'react', 'vue', 'angular', 'django', 'flask', 'express',
      '数据库', 'database', 'mysql', 'postgresql',
      'docker', 'kubernetes', 'dockerfile',
      'html', 'css', 'typescript',
      'npm', 'yarn', 'pip', 'install', '依赖', 'dependency',
      'webpack', 'vite', 'rollup', 'babel', 'eslint', 'prettier',
      'git', 'commit', 'push', 'pull', 'branch', 'merge',
      'json', 'yaml', 'yml', 'xml', 'config', '配置',
      'socket', 'websocket', 'http', 'https', 'tcp', 'udp',
      'lambda', 'serverless', 'cloud', 'aws', 'azure', 'gcp',
      '项目', 'project', '工程', 'workspace'
    ];

    this.nonProgrammingKeywords = [
      '聊天', '对话', '闲聊', 'talk', 'chat', 'conversation',
      '故事', 'story', '小说', 'novel',
      '翻译', 'translate',
      '解释', 'explain', '说明',
      '总结', 'summary',
      '建议', 'suggest', 'advice',
      '评价', '评价一下', 'review',
      '帮我看看', '帮我想想',
      '什么是', '什么叫做', 'what is', 'what does',
      '为什么', 'why',
      '如何', 'how',
      '多少', '多少钱', 'how much',
      '哪里', 'where',
      '什么时候', 'when',
      '谁', 'who',
      '天气', '天气预报', 'weather',
      '新闻', 'news',
      '音乐', 'music', 'song',
      '电影', 'movie', 'film',
      '体育', 'sports',
      '股票', 'stock', 'finance',
      '健康', 'health',
      '美食', 'food', 'recipe'
    ];

    this.programmingPatterns = [
      /```(python|javascript|js|typescript|ts|java|cpp|c\+\+|c#|csharp|go|rust|html|css|sql|json|yaml|yml|bash|shell|dockerfile|vue|react|xml)\s*$/mi,
      /^(def|function|class|import|export|const|let|var|async|await)\s+/,
      /\b(traceback|exception|error:|syntax error|compile error|runtime error)\b/i,
      /\.(py|js|ts|java|cpp|cxx|cc|go|rs|html|css|sql|json|yaml|yml|xml|md|txt|sh|bat|ps1)$/,
      /dockerfile|docker-compose|package\.json|requirements\.txt|setup\.py|pom\.xml|build\.gradle/,
      /npm\s+(install|run|start|build|test)|yarn\s+(install|add|run)|pip\s+(install|upgrade)/,
      /git\s+(clone|pull|push|commit|branch|merge)/,
      /\b(http:\/\/|https:\/\/)[^\s]+\b/,
      /\b(api|endpoint|route|url|request|response)\b/i,
      /\b(redis|mongodb|sqlite|postgres|mysql)\b/i,
      /\b(decorator|@\w+|optional chaining|\?\?|\?\.)/,
      /\b(generator|yield|async function|await\s+\w+)/,
      /\b(lambda|arrow function|=>|->)\b/,
      /\b(struct|interface|enum|type\s+alias|union type|generic)\b/i,
      /\b(webpack|vite|rollup|babel|eslint|prettier|jest|pytest|mocha)\b/i,
      /^[A-Za-z]:\\[^<>:"|?*\r\n]+$/,
      /^\/[^<>:"|?*\r\n]+$/,
      /^~\/[^<>:"|?*\r\n]+$/,
      /\.\/[^<>:"|?*\r\n]+$/,
      /\.\.\/[^<>:"|?*\r\n]+$/
    ];
  }

  classify (task) {
    if (!task || typeof task !== 'string') {
      return { type: 'invalid', confidence: 0.9 };
    }

    const trimmedTask = task.trim();

    if (trimmedTask.length === 0) {
      return { type: 'invalid', confidence: 1.0 };
    }

    if (trimmedTask.length <= 10) {
      for (const pattern of this.greetingPatterns) {
        if (pattern.test(trimmedTask)) {
          return { type: 'greeting', confidence: 0.95 };
        }
      }
    }

    for (const pattern of this.programmingPatterns) {
      if (pattern.test(task)) {
        return { type: 'programming', confidence: 0.9 };
      }
    }

    let programmingScore = 0;
    let nonProgrammingScore = 0;

    for (const keyword of this.programmingKeywords) {
      if (task.toLowerCase().includes(keyword.toLowerCase())) {
        programmingScore++;
      }
    }

    for (const keyword of this.nonProgrammingKeywords) {
      if (task.toLowerCase().includes(keyword.toLowerCase())) {
        nonProgrammingScore++;
      }
    }

    const hasCodeBlock = task.includes('```') && (
      task.includes('python') || task.includes('javascript') || task.includes('java') ||
      task.includes('cpp') || task.includes('typescript') || task.includes('html')
    );
    if (hasCodeBlock) {
      programmingScore += 2;
    }

    const hasErrorMsg = task.includes('error') && (task.includes('traceback') || task.includes('Exception'));
    if (hasErrorMsg) {
      programmingScore += 2;
    }

    if (programmingScore >= 2) {
      return { type: 'programming', confidence: Math.min(0.95, programmingScore / 5) };
    }

    if (nonProgrammingScore >= 2 && programmingScore === 0) {
      return { type: 'chat', confidence: Math.min(0.9, nonProgrammingScore / 5) };
    }

    if (programmingScore === 0 && nonProgrammingScore === 0) {
      if (trimmedTask.length <= 20) {
        return { type: 'chat', confidence: 0.7 };
      }
      return { type: 'uncertain', confidence: 0.5 };
    }

    if (programmingScore > nonProgrammingScore) {
      return { type: 'programming', confidence: Math.min(0.85, programmingScore / (programmingScore + nonProgrammingScore)) };
    }

    return { type: 'chat', confidence: Math.min(0.85, nonProgrammingScore / (programmingScore + nonProgrammingScore)) };
  }

  isProgrammingTask (task) {
    const classification = this.classify(task);
    return classification.type === 'programming';
  }

  isChatTask (task) {
    const classification = this.classify(task);
    return classification.type === 'chat' || classification.type === 'greeting';
  }

  getRecommendedAction (task) {
    const classification = this.classify(task);

    switch (classification.type) {
    case 'greeting':
      return { action: 'chat', message: '识别为问候语，建议直接回复', confidence: classification.confidence };
    case 'chat':
      return { action: 'chat', message: '识别为聊天任务，建议直接对话', confidence: classification.confidence };
    case 'programming':
      return { action: 'execute', message: '识别为编程任务，建议执行代码生成流程', confidence: classification.confidence };
    case 'invalid':
      return { action: 'reject', message: '无效任务，请输入有效内容', confidence: classification.confidence };
    default:
      return { action: 'execute', message: '不确定类型，默认执行编程流程', confidence: classification.confidence };
    }
  }
}

module.exports = TaskClassifier;
