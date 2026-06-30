# Release Notes - v2.0.0

## 🎉 Qidi Agent v2.0.0 Released!

> **Free AI models orchestrate to write code that rivals top-tier LLMs — at zero cost.**

Release Date: 2026-07-01

---

## What's New in v2.0.0

### 🌟 Major Features

#### 1. Multi-Provider Parallel Execution
- **New `multi` execution mode** for parallel AI code generation
- **MultiProviderRunner**: Standalone module for orchestrating multiple AI providers simultaneously
- **Best result selection**: Automatically picks the highest quality code from multiple outputs

#### 2. New Tool Adapters
- **KimiWorkAdapter**: Support for KimiWork AI coding assistant
- **WorkBuddyAdapter**: Support for WorkBuddy productivity tool
- **ZCodeAdapter**: Support for ZCode IDE plugin

#### 3. TaskExecutor Refactoring
- Extracted `MultiProviderRunner` from `TaskOrchestrator`
- Eliminated dynamic `require()` calls inside functions
- Improved code maintainability and testability

### ✨ Improvements

#### Star Optimization
- **English README.md** as primary language for international visibility
- **Chinese README.zh-CN.md** for local users
- **Docker Support**: Dockerfile, docker-compose.yml, and .devcontainer configuration
- **GitHub Codespaces**: One-click cloud development environment
- **Updated keywords**: Better GitHub search discoverability

#### Test Coverage
- **58 comprehensive tests** (up from 53)
- **100% pass rate**
- New tests for multi-provider mode
- New tests for refineCode loop functionality

#### Code Quality
- Fixed lint errors in all 3 new adapters
- Improved error handling
- Better TypeScript-ready architecture

---

## Comparison: Before vs After

| Feature | v1.3.x | v2.0.0 |
|---------|--------|--------|
| Multi-Provider Mode | ❌ | ✅ |
| KimiWork Adapter | ❌ | ✅ |
| WorkBuddy Adapter | ❌ | ✅ |
| ZCode Adapter | ❌ | ✅ |
| English README | ❌ | ✅ |
| Docker Support | ❌ | ✅ |
| Codespaces | ❌ | ✅ |
| Test Count | 53 | 58 |
| TaskExecutor Lines | 678 | 526 |

---

## Installation

```bash
# Clone the repository
git clone https://github.com/qidiai/QiDi-Agent.git
cd QiDi-Agent

# Install dependencies
npm install

# Quick start (uses Ollama local model)
npm start

# Or start with WebUI
npm run web
```

### Docker Installation

```bash
# Pull and run with Docker
docker-compose up

# Or build manually
docker build -t qidi-agent .
docker run -p 3000:3000 qidi-agent
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Qidi Agent                         │
├─────────────────────────────────────────────────────────┤
│  Task Input → Task Splitter → Multi-Provider Dispatch   │
├─────────────────────────────────────────────────────────┤
│     ┌─────────┐  ┌─────────┐  ┌─────────┐               │
│     │ Ollama  │  │ DeepSeek│  │ Claude  │  ...         │
│     └────┬────┘  └────┬────┘  └────┬────┘               │
│          │            │            │                    │
│          └────────────┼────────────┘                    │
│                       ↓                                  │
│              MultiProviderRunner                        │
│                       ↓                                  │
│              Quality Checker                            │
│                       ↓                                  │
│                 Merge Engine                            │
│                       ↓                                  │
│              Final Code Output                          │
└─────────────────────────────────────────────────────────┘
```

---

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Ollama (Local, Free)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b

# DeepSeek (Cloud, API Key Required)
DEEPSEEK_API_KEY=sk-your-key-here

# Anthropic Claude (Cloud, API Key Required)
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### Multi-Provider Configuration

Edit `config/agents.json`:

```json
{
  "dispatch": {
    "mode": "parallel",
    "parallelLimit": 3,
    "compareResults": true,
    "selectBest": true
  }
}
```

---

## Testing

```bash
# Run all tests
npm test

# Run specific test
node test/comprehensive_test.js

# Run benchmark (requires Ollama)
node test/benchmark.js
```

---

## Docker & Cloud Development

### Docker Compose (Recommended)

```bash
docker-compose up
# Access WebUI at http://localhost:3000
```

### GitHub Codespaces

Click the "Code" button on GitHub → "Create codespace on main"

---

## Known Issues Fixed in v2.0.0

- ✅ API Key hardcoding vulnerability - now uses environment variables
- ✅ TaskExecutor monolithic design - refactored into smaller modules
- ✅ No multi-provider support - now supports parallel execution
- ✅ Poor international visibility - added English README and GitHub optimization

---

## Breaking Changes

- **Minimum Node.js version**: 16.0.0 (unchanged)
- **Configuration format**: Compatible with v1.x

---

## Contributors

Thanks to all contributors who made this release possible!

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

## Support

- 📖 [Documentation](./docs/)
- 💬 [Issues](https://github.com/qidiai/QiDi-Agent/issues)
- 📝 [Changelog](./CHANGELOG.md)
