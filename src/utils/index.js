'use strict';

/**
 * 工具函数统一导出
 */

const Logger = require('./Logger');
const HttpClient = require('./HttpClient');
const SafeParser = require('./SafeParser');
const CacheStore = require('./CacheStore');
const ConfirmPrompt = require('./ConfirmPrompt');
const ContextCompressor = require('./ContextCompressor');
const ExperimentReportGenerator = require('./ExperimentReportGenerator');
const FileManager = require('./FileManager');
const ModelRouter = require('./ModelRouter');
const TaskClassifier = require('./TaskClassifier');
const TokenCounter = require('./TokenCounter');
const VersionManager = require('./VersionManager');
const {
  AppError,
  NetworkError,
  TimeoutError,
  HttpError,
  JsonParseError
} = require('./AppError');

module.exports = {
  // 自定义异常
  AppError,
  NetworkError,
  TimeoutError,
  HttpError,
  JsonParseError,

  // 日志
  Logger,

  // HTTP 客户端
  HttpClient,

  // 安全解析
  SafeParser,
  safeJsonParse: SafeParser.safeJsonParse,
  safeJsonStringify: SafeParser.safeJsonStringify,
  safeExtractJson: SafeParser.safeExtractJson,

  // 缓存
  CacheStore,

  // 交互
  ConfirmPrompt,

  // AI
  ContextCompressor,
  ModelRouter,
  TaskClassifier,
  TokenCounter,

  // 文件
  FileManager,

  // 报告
  ExperimentReportGenerator,

  // 版本
  VersionManager
};
