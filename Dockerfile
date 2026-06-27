# 启迪 Agent 多阶段构建
# 阶段1: 安装依赖  阶段2: 运行时

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:22-alpine AS runtime
WORKDIR /app

LABEL org.opencontainers.image.title="Qidi Agent"
LABEL org.opencontainers.image.description="多 AI 编程工具统一编排与协作平台"
LABEL org.opencontainers.image.source="https://github.com/qidi/ai-orchestrator"
LABEL org.opencontainers.image.licenses="MIT"

# 非根用户运行
RUN addgroup -S qidi && adduser -S qidi -G qidi
COPY --from=builder /app /app
RUN chown -R qidi:qidi /app
USER qidi

EXPOSE 3000

ENV NODE_ENV=production
ENV LOG_LEVEL=info

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => r.statusCode===200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

ENTRYPOINT ["node", "src/cli/index.js"]
CMD ["--help"]
