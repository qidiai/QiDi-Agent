const BaseToolAdapter = require('./BaseToolAdapter');
const ClaudeCodeAdapter = require('./ClaudeCodeAdapter');
const OpenCodeAdapter = require('./OpenCodeAdapter');
const OpenClawAdapter = require('./OpenClawAdapter');
const QoderAdapter = require('./QoderAdapter');
const HermesAgentAdapter = require('./HermesAgentAdapter');
const AtomCodeAdapter = require('./AtomCodeAdapter');
const MimoCodeAdapter = require('./MimoCodeAdapter');
const TraeAdapter = require('./TraeAdapter');

module.exports = {
  BaseToolAdapter,
  ClaudeCodeAdapter,
  OpenCodeAdapter,
  OpenClawAdapter,
  QoderAdapter,
  HermesAgentAdapter,
  AtomCodeAdapter,
  MimoCodeAdapter,
  TraeAdapter,

  createAll () {
    return [
      new ClaudeCodeAdapter(),
      new OpenCodeAdapter(),
      new OpenClawAdapter(),
      new QoderAdapter(),
      new HermesAgentAdapter(),
      new AtomCodeAdapter(),
      new MimoCodeAdapter(),
      new TraeAdapter()
    ];
  },

  create (name) {
    const adapters = {
      'claude-code': ClaudeCodeAdapter,
      'open-code': OpenCodeAdapter,
      openclaw: OpenClawAdapter,
      qoder: QoderAdapter,
      'hermes-agent': HermesAgentAdapter,
      'atom-code': AtomCodeAdapter,
      'mimo-code': MimoCodeAdapter,
      trae: TraeAdapter
    };

    const AdapterClass = adapters[name];
    if (AdapterClass) {
      return new AdapterClass();
    }

    throw new Error(`未知工具: ${name}`);
  }
};
