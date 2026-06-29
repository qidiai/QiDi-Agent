let currentPage = 'dashboard';
let currentFilesTab = 'files';
let dashboardData = null;
let toolsData = [];
let agentsData = [];
let conversationHistory = [];
let currentTaskMsgId = null;
let customSystemPrompt = null;
let chatSessionId = null;
let reportsData = [];
let tokensData = [];

document.addEventListener('DOMContentLoaded', () => {
  // 从 localStorage 恢复聊天记录
  restoreChatFromStorage();
  initNavigation();
  loadAllData();
  setInterval(loadDashboard, 30000);
});

function initNavigation () {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      switchPage(page);
    });
  });
}

function switchPage (page) {
  currentPage = page;

  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    if (item.dataset.page === page) {
      item.classList.add('active');
    }
  });

  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
  });
  document.getElementById(`page-${page}`).classList.add('active');

  const titles = {
    dashboard: '仪表盘',
    console: 'Agent',
    tools: '工具管理',
    agents: '模型管理',
    routing: '智能路由',
    tokens: 'Token 统计',
    tasks: '任务管理',
    files: '文件与报告'
  };
  document.getElementById('page-title').textContent = titles[page] || '仪表盘';

  if (page === 'dashboard') loadDashboard();
  if (page === 'console') initConsole();
  if (page === 'tools') loadTools();
  if (page === 'agents') loadAgents();
  if (page === 'routing') loadRoutingConfig();
  if (page === 'tokens') loadTokens();
  if (page === 'tasks') loadTasks();
  if (page === 'files') {
    switchFilesTab(currentFilesTab || 'files');
    loadReports();
  }
}

async function loadAllData () {
  await loadDashboard();
}

async function loadDashboard () {
  try {
    const res = await fetch('/api/dashboard');
    const data = await res.json();
    dashboardData = data;
    renderDashboard(data);
  } catch (e) {
    console.error('加载仪表盘数据失败:', e);
  }
}

function renderDashboard (data) {
  document.getElementById('stat-tools').textContent = data.summary.totalTools;
  document.getElementById('stat-tools-online').textContent = `${data.summary.onlineTools} 在线`;
  document.getElementById('stat-agents').textContent = data.summary.totalAgents;
  document.getElementById('stat-agents-active').textContent = `${data.summary.activeAgents} 活跃`;
  document.getElementById('stat-tokens').textContent = formatNumber(data.summary.totalTokens);
  document.getElementById('stat-reports').textContent = data.summary.totalReports;
  document.getElementById('stat-success-rate').textContent = `${data.summary.avgSuccessRate}% 成功率`;

  renderToolsPreview(data.tools);
  renderAgentsPreview(data.agents);
  renderTokensPreview(data.tokenStats);
  renderReportsPreview(data.recentReports);

  toolsData = data.tools;
  agentsData = data.agents;
  tokensData = data.tokenStats;
  reportsData = data.recentReports;
}

function renderToolsPreview (tools) {
  const container = document.getElementById('tools-preview');
  if (!tools || tools.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔧</div><div class="empty-text">暂无工具</div></div>';
    return;
  }

  const preview = tools.slice(0, 4);
  container.innerHTML = preview.map(tool => `
    <div class="tool-item" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6;">
      <div>
        <div style="font-weight:500;font-size:13px;">${tool.displayName || tool.name}</div>
        <div style="font-size:11px;color:#9ca3af;">${tool.version || '未知版本'}</div>
      </div>
      <span class="status-badge status-${tool.status || 'offline'}">${getStatusText(tool.status)}</span>
    </div>
  `).join('');
}

function renderAgentsPreview (agents) {
  const container = document.getElementById('agents-preview');
  if (!agents || agents.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🤖</div><div class="empty-text">暂无智能体</div></div>';
    return;
  }

  const preview = agents.slice(0, 4);
  container.innerHTML = preview.map(agent => `
    <div class="agent-item" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6;">
      <div>
        <div style="font-weight:500;font-size:13px;">${agent.displayName || agent.name}</div>
        <div style="font-size:11px;color:#9ca3af;">${agent.role || '未知角色'}</div>
      </div>
      <span class="status-badge status-${agent.status || 'idle'}">${getAgentStatusText(agent.status)}</span>
    </div>
  `).join('');
}

function renderTokensPreview (tokens) {
  const container = document.getElementById('tokens-preview');
  if (!tokens || tokens.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">💰</div><div class="empty-text">暂无数据</div></div>';
    return;
  }

  const maxTokens = Math.max(...tokens.map(t => t.total || 0), 1);
  const sorted = [...tokens].sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 4);

  container.innerHTML = sorted.map(t => `
    <div class="token-item" style="padding:8px 0;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
        <span style="font-weight:500;">${t.agent}</span>
        <span style="color:#6b7280;">${formatNumber(t.total || 0)}</span>
      </div>
      <div class="token-bar">
        <div class="token-bar-fill" style="width: ${((t.total || 0) / maxTokens) * 100}%"></div>
      </div>
    </div>
  `).join('');
}

function renderReportsPreview (reports) {
  const container = document.getElementById('reports-preview');
  if (!reports || reports.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><div class="empty-text">暂无报告</div></div>';
    return;
  }

  const preview = reports.slice(0, 4);
  container.innerHTML = preview.map(report => `
    <div class="report-item">
      <div class="report-item-info">
        <h4>${truncate(report.task || '未命名任务', 40)}</h4>
        <div class="report-item-meta">
          <span>成功率: ${report.successRate}%</span>
          <span>${formatDate(report.timestamp)}</span>
        </div>
      </div>
      <span class="report-item-action" onclick="viewReport('${report.id}')">查看</span>
    </div>
  `).join('');
}

async function loadTools () {
  try {
    const res = await fetch('/api/tools');
    const data = await res.json();
    toolsData = data.tools;
    renderToolsFull(data.tools);
  } catch (e) {
    console.error('加载工具列表失败:', e);
  }
}

function renderToolsFull (tools) {
  const container = document.getElementById('tools-full');
  // 同步 Agent 页底部工具数量徽标
  const countEl = document.getElementById('tools-panel-count');
  if (countEl) countEl.textContent = `${(tools || []).length} 个`;
  if (!tools || tools.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔧</div><div class="empty-text">暂无工具</div><div class="empty-desc">点击上方"扫描本机工具"按钮检测已安装的AI工具</div></div>';
    return;
  }

  container.innerHTML = tools.map(tool => `
    <div class="tool-card">
      <div class="tool-header">
        <div>
          <div class="tool-name">${tool.displayName || tool.name}</div>
          <div class="tool-desc">${tool.description || ''}</div>
        </div>
        <span class="status-badge status-${tool.status || 'offline'}">${getStatusText(tool.status)}</span>
      </div>
      <div class="tool-meta">
        ${tool.version ? `<span>版本: ${tool.version}</span>` : ''}
        ${tool.detected ? '<span style="color:#10b981;">✓ 已检测</span>' : '<span style="color:#9ca3af;">未检测</span>'}
      </div>
      ${tool.installPath ? `<div style="font-size:11px;color:#9ca3af;margin-top:8px;word-break:break-all;">路径: ${tool.installPath}</div>` : ''}
      <div class="tool-actions">
        <button class="btn btn-primary" onclick="connectTool('${tool.name}')" ${tool.status === 'online' ? 'disabled' : ''}>
          ${tool.status === 'online' ? '已连接' : '连接'}
        </button>
        <button class="btn" onclick="viewToolDetail('${tool.name}')">详情</button>
      </div>
    </div>
  `).join('');
}

async function scanTools () {
  const btn = event.target.closest('button');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span>⏳</span> 扫描中...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/tools/scan', { method: 'POST' });
    const data = await res.json();
    await loadTools();
    await loadDashboard();
    alert(`扫描完成！检测到 ${data.results.filter(r => r.detected).length} 个工具`);
  } catch (e) {
    alert('扫描失败: ' + e.message);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function connectTool (name) {
  try {
    const res = await fetch(`/api/tools/connect/${name}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert(`${name} 连接成功！`);
      loadTools();
      loadDashboard();
    } else {
      alert(`连接失败: ${data.message}`);
    }
  } catch (e) {
    alert('连接失败: ' + e.message);
  }
}

async function viewToolDetail (name) {
  try {
    const res = await fetch(`/api/tools/${name}/detail`);
    const data = await res.json();
    showToolDetailModal(data);
  } catch (e) {
    alert('获取详情失败: ' + e.message);
  }
}

function showToolDetailModal (tool) {
  const modal = document.getElementById('report-modal');
  document.getElementById('modal-title').textContent = `${tool.displayName || tool.name} - 工具详情`;

  let content = `工具名称: ${tool.displayName || tool.name}\n`;
  content += `状态: ${getStatusText(tool.status)}\n`;
  content += `版本: ${tool.version || '未知'}\n`;
  content += `安装路径: ${tool.installPath || '未检测到'}\n`;
  content += `命令: ${tool.command || '未知'}\n\n`;

  if (tool.tokenUsage) {
    content += `Token消耗: ${formatNumber(tool.tokenUsage.total || 0)}\n`;
    content += `  - 输入: ${formatNumber(tool.tokenUsage.prompt || 0)}\n`;
    content += `  - 输出: ${formatNumber(tool.tokenUsage.completion || 0)}\n\n`;
  }

  if (tool.workFiles && tool.workFiles.length > 0) {
    content += `工作文件 (${tool.workFiles.length}个):\n`;
    tool.workFiles.slice(0, 20).forEach(f => {
      content += `  ${f.path} (${formatSize(f.size)})\n`;
    });
    if (tool.workFiles.length > 20) {
      content += `  ... 还有 ${tool.workFiles.length - 20} 个文件\n`;
    }
  } else {
    content += '工作文件: 暂无\n';
  }

  document.getElementById('modal-content').textContent = content;
  modal.style.display = 'flex';
}

async function loadAgents () {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    agentsData = data.agents;
    renderAgentsFull(data.agents);
  } catch (e) {
    console.error('加载模型失败:', e);
  }
}

function renderAgentsFull (agents) {
  const container = document.getElementById('agents-full');
  if (!agents || agents.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🤖</div><div class="empty-text">暂无模型</div><div class="empty-desc">请在配置文件中添加模型</div></div>';
    return;
  }

  const localModels = agents.filter(a => a.isLocal);
  const cloudModels = agents.filter(a => a.isCloud);

  let html = '<div style="margin-bottom: 24px;"><h4 style="font-size: 14px; color: #6b7280; margin-bottom: 12px;">🖥️ 本地模型</h4>';
  if (localModels.length > 0) {
    html += '<div class="agents-grid">' + localModels.map(agent => renderAgentCard(agent)).join('') + '</div>';
  } else {
    html += '<div class="empty-state" style="padding: 20px;"><div class="empty-text">暂无本地模型</div><div class="empty-desc">请确保 Ollama 已安装并运行</div></div>';
  }
  html += '</div>';

  html += '<div><h4 style="font-size: 14px; color: #6b7280; margin-bottom: 12px;">☁️ 云端模型</h4>';
  if (cloudModels.length > 0) {
    html += '<div class="agents-grid">' + cloudModels.map(agent => renderAgentCard(agent)).join('') + '</div>';
  } else {
    html += '<div class="empty-state" style="padding: 20px;"><div class="empty-text">暂无云端模型</div></div>';
  }
  html += '</div>';

  container.innerHTML = html;
}

function renderAgentCard (agent) {
  const statusClass = agent.enabled ? 'status-online' : 'status-offline';
  const statusText = agent.enabled ? '已启用' : '已禁用';
  const typeTag = agent.isLocal ? '本地' : '云端';
  const apiInfo = agent.apiConfig?.baseURL ? `<span>${agent.apiConfig.baseURL.replace('https://', '').replace('http://', '')}</span>` : '';

  return `
    <div class="agent-card">
      <div class="agent-header">
        <div>
          <div class="agent-name">${agent.displayName || agent.name}</div>
          <div class="tool-desc">${agent.description || ''}</div>
        </div>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="agent-meta">
        <span style="background: ${agent.isLocal ? '#dbeafe' : '#fce7f3'}; color: ${agent.isLocal ? '#1d4ed8' : '#be185d'};">${typeTag}</span>
        <span>模型: ${agent.model || '未知'}</span>
        ${apiInfo}
      </div>
      <div class="tool-meta" style="margin-top: 8px;">
        <span>Token消耗: ${formatNumber(agent.tokenUsage?.total || 0)}</span>
      </div>
      <div class="tool-actions" style="margin-top: 12px;">
        ${agent.enabled
    ? `<button class="btn" style="background:#fee2e2;color:#dc2626;" onclick="disableAgent('${agent.name}')">禁用</button>`
    : `<button class="btn btn-success" onclick="enableAgent('${agent.name}')">启用</button>`
}
        <button class="btn" onclick="showEditModelModal('${agent.name}')">编辑</button>
        <button class="btn" style="color:#dc2626;" onclick="deleteModel('${agent.name}')">删除</button>
      </div>
    </div>
  `;
}

async function enableAgent (name) {
  try {
    const res = await fetch(`/api/agents/${name}/enable`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert(`${name} 已启用！`);
      loadAgents();
      loadDashboard();
    } else {
      alert(`启用失败: ${data.message}`);
    }
  } catch (e) {
    alert('启用失败: ' + e.message);
  }
}

async function disableAgent (name) {
  try {
    const res = await fetch(`/api/agents/${name}/disable`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert(`${name} 已禁用`);
      loadAgents();
      loadDashboard();
    } else {
      alert(`禁用失败: ${data.message}`);
    }
  } catch (e) {
    alert('禁用失败: ' + e.message);
  }
}

function showAddModelModal () {
  document.getElementById('model-modal-title').textContent = '添加模型';
  document.getElementById('model-form').reset();
  document.getElementById('model-name-original').value = '';
  document.getElementById('model-name').disabled = false;
  document.getElementById('model-type').disabled = false;
  document.getElementById('model-modal').style.display = 'flex';
}

function showEditModelModal (name) {
  const agent = agentsData.find(a => a.name === name);
  if (!agent) {
    alert('模型不存在');
    return;
  }

  document.getElementById('model-modal-title').textContent = '编辑模型';
  document.getElementById('model-name-original').value = name;
  document.getElementById('model-name').value = agent.fullName || agent.name;
  document.getElementById('model-name').disabled = true;
  document.getElementById('model-type').value = agent.provider || 'openai';
  document.getElementById('model-type').disabled = true;
  document.getElementById('model-baseurl').value = agent.apiConfig?.baseURL || '';
  document.getElementById('model-model').value = agent.model || '';
  document.getElementById('model-apikey').value = '';
  document.getElementById('model-description').value = agent.description || '';
  document.getElementById('model-timeout').value = '60000';
  document.getElementById('model-modal').style.display = 'flex';
}

function closeModelModal () {
  document.getElementById('model-modal').style.display = 'none';
}

function updateModelDefaults () {
  const type = document.getElementById('model-type').value;
  const baseURLInput = document.getElementById('model-baseurl');
  const modelInput = document.getElementById('model-model');

  const defaults = {
    openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4' },
    anthropic: { baseURL: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20240620' },
    ollama: { baseURL: 'http://localhost:11434', model: 'qwen2.5:7b' },
    custom: { baseURL: '', model: '' }
  };

  if (defaults[type]) {
    if (!baseURLInput.value) baseURLInput.value = defaults[type].baseURL;
    if (!modelInput.value) modelInput.value = defaults[type].model;
  }
}

async function saveModel (event) {
  event.preventDefault();

  const originalName = document.getElementById('model-name-original').value;
  const isEdit = !!originalName;

  const modelData = {
    name: document.getElementById('model-name').value.trim(),
    type: document.getElementById('model-type').value,
    baseURL: document.getElementById('model-baseurl').value.trim(),
    model: document.getElementById('model-model').value.trim(),
    apiKey: document.getElementById('model-apikey').value.trim(),
    description: document.getElementById('model-description').value.trim(),
    timeout: parseInt(document.getElementById('model-timeout').value) || 60000
  };

  if (!modelData.name || !modelData.baseURL || !modelData.model) {
    alert('请填写必填项');
    return;
  }

  try {
    let res, data;

    if (isEdit) {
      res = await fetch(`/api/models/${originalName}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelData)
      });
    } else {
      res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelData)
      });
    }

    data = await res.json();

    if (data.success) {
      alert(data.message);
      closeModelModal();
      loadAgents();
      loadDashboard();
    } else {
      alert('保存失败: ' + data.message);
    }
  } catch (e) {
    alert('保存失败: ' + e.message);
  }
}

async function deleteModel (name) {
  if (!confirm(`确定要删除模型 ${name} 吗？`)) {
    return;
  }

  try {
    const res = await fetch(`/api/models/${name}`, { method: 'DELETE' });
    const data = await res.json();

    if (data.success) {
      alert(data.message);
      loadAgents();
      loadDashboard();
    } else {
      alert('删除失败: ' + data.message);
    }
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}

async function viewAgentDetail (name) {
  try {
    const res = await fetch(`/api/agents/${name}/status`);
    const data = await res.json();
    showAgentDetailModal(data);
  } catch (e) {
    alert('获取详情失败: ' + e.message);
  }
}

function showAgentDetailModal (agent) {
  const modal = document.getElementById('report-modal');
  document.getElementById('modal-title').textContent = `${agent.name} - 智能体详情`;

  let content = `智能体: ${agent.name}\n`;
  content += `状态: ${getAgentStatusText(agent.status)}\n`;
  content += `最后活跃: ${agent.lastActive ? formatDate(agent.lastActive) : '从未活跃'}\n\n`;

  if (agent.currentTask) {
    content += `当前任务: ${agent.currentTask}\n\n`;
  }

  if (agent.tokenUsage) {
    content += 'Token消耗统计:\n';
    content += `  总计: ${formatNumber(agent.tokenUsage.total || 0)}\n`;
    content += `  输入: ${formatNumber(agent.tokenUsage.prompt || 0)}\n`;
    content += `  输出: ${formatNumber(agent.tokenUsage.completion || 0)}\n`;
    if (agent.tokenUsage.calls) {
      content += `  调用次数: ${agent.tokenUsage.calls}\n`;
    }
    content += '\n';
  }

  if (agent.workFiles && agent.workFiles.length > 0) {
    content += `工作文件 (${agent.workFiles.length}个):\n`;
    agent.workFiles.slice(0, 30).forEach(f => {
      content += `  ${f.path} (${formatSize(f.size)})\n`;
    });
    if (agent.workFiles.length > 30) {
      content += `  ... 还有 ${agent.workFiles.length - 30} 个文件\n`;
    }
  } else {
    content += '工作文件: 暂无\n';
  }

  document.getElementById('modal-content').textContent = content;
  modal.style.display = 'flex';
}

async function loadTokens () {
  try {
    const res = await fetch('/api/tokens');
    const data = await res.json();
    tokensData = data.tokens;
    renderTokensFull(data.tokens);
  } catch (e) {
    console.error('加载Token统计失败:', e);
  }
}

function renderTokensFull (tokens) {
  const container = document.getElementById('tokens-full');
  if (!tokens || tokens.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">💰</div><div class="empty-text">暂无Token消耗数据</div></div>';
    return;
  }

  const maxTokens = Math.max(...tokens.map(t => t.total || 0), 1);
  const totalTokens = tokens.reduce((s, t) => s + (t.total || 0), 0);

  container.innerHTML = `
    <div style="margin-bottom:16px;padding:12px;background:#f9fafb;border-radius:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:13px;color:#6b7280;">总消耗</span>
        <span style="font-size:18px;font-weight:600;color:#1a1a2e;">${formatNumber(totalTokens)} tokens</span>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>智能体/工具</th>
          <th>总消耗</th>
          <th>输入</th>
          <th>输出</th>
          <th style="width:200px;">占比</th>
        </tr>
      </thead>
      <tbody>
        ${tokens.sort((a, b) => (b.total || 0) - (a.total || 0)).map(t => `
          <tr>
            <td style="font-weight:500;">${t.agent}</td>
            <td>${formatNumber(t.total || 0)}</td>
            <td style="color:#6b7280;">${formatNumber(t.prompt || 0)}</td>
            <td style="color:#6b7280;">${formatNumber(t.completion || 0)}</td>
            <td>
              <div class="token-bar">
                <div class="token-bar-fill" style="width: ${((t.total || 0) / maxTokens) * 100}%"></div>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function loadReports () {
  try {
    const res = await fetch('/api/reports?limit=50');
    const data = await res.json();
    reportsData = data.reports;
    renderReportsFull(data.reports);
  } catch (e) {
    console.error('加载报告失败:', e);
  }
}

function renderReportsFull (reports) {
  const container = document.getElementById('reports-full');
  if (!reports || reports.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><div class="empty-text">暂无报告</div><div class="empty-desc">任务完成后将自动生成实验报告</div></div>';
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>任务</th>
          <th>状态</th>
          <th>成功率</th>
          <th>质量分</th>
          <th>耗时</th>
          <th>标签</th>
          <th>时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${reports.map(r => `
          <tr>
            <td style="max-width:300px;">
              <div style="font-weight:500;">${truncate(r.task || '未命名', 50)}</div>
            </td>
            <td>
              <span class="status-badge ${r.successRate === 100 ? 'status-online' : r.successRate >= 50 ? 'status-busy' : 'status-error'}">
                ${r.successRate === 100 ? '成功' : r.successRate >= 50 ? '部分成功' : '失败'}
              </span>
            </td>
            <td>${r.successRate}%</td>
            <td>${r.qualityScore || '-'}</td>
            <td>${r.duration ? (r.duration / 1000).toFixed(1) + 's' : '-'}</td>
            <td>
              ${(r.tags || []).slice(0, 2).map(t => `<span style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:11px;">${t}</span>`).join(' ')}
            </td>
            <td style="color:#6b7280;font-size:12px;">${formatDate(r.timestamp)}</td>
            <td>
              <span class="report-item-action" onclick="viewReport('${r.id}')">查看</span>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function searchReports () {
  const query = document.getElementById('report-search').value.toLowerCase();
  if (!query) {
    renderReportsFull(reportsData);
    return;
  }

  const filtered = reportsData.filter(r =>
    (r.task || '').toLowerCase().includes(query) ||
    (r.tags || []).some(t => t.toLowerCase().includes(query))
  );
  renderReportsFull(filtered);
}

async function viewReport (id) {
  try {
    const res = await fetch(`/api/reports/${id}`);
    const data = await res.json();
    showReportModal(data);
  } catch (e) {
    alert('加载报告失败: ' + e.message);
  }
}

function showReportModal (report) {
  const modal = document.getElementById('report-modal');
  document.getElementById('modal-title').textContent = '实验报告详情';
  document.getElementById('modal-content').textContent = report.content || JSON.stringify(report, null, 2);
  modal.style.display = 'flex';
}

function closeReportModal () {
  document.getElementById('report-modal').style.display = 'none';
}

async function loadTasks () {
  try {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    renderTasksFull(data.tasks);
  } catch (e) {
    console.error('加载任务失败:', e);
  }
}

function renderTasksFull (tasks) {
  const container = document.getElementById('tasks-full');
  if (!tasks || tasks.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">暂无任务</div><div class="empty-desc">任务开始后将在这里显示</div></div>';
    return;
  }

  container.innerHTML = tasks.map(task => `
    <div class="task-item">
      <div class="task-item-header">
        <div class="task-item-title">${task.title || task.id}</div>
        <span class="status-badge status-${task.status || 'idle'}">${getTaskStatusText(task.status)}</span>
      </div>
      <div style="font-size:12px;color:#6b7280;">${task.description || ''}</div>
      ${task.progress !== undefined
    ? `
        <div class="task-progress">
          <div class="task-progress-fill" style="width: ${task.progress}%"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px;text-align:right;">${task.progress}%</div>
      `
    : ''}
    </div>
  `).join('');
}

function refreshData () {
  loadAllData();
  const page = currentPage;
  if (page !== 'dashboard') {
    if (page === 'agents') loadAgents();
    if (page === 'tokens') loadTokens();
    if (page === 'tasks') loadTasks();
    if (page === 'files') switchFilesTab(currentFilesTab || 'files');
  }
}

async function loadRoutingConfig () {
  try {
    const res = await fetch('/api/routing/config');
    const config = await res.json();
    renderRoutingConfig(config);
  } catch (e) {
    console.error('加载路由配置失败:', e);
  }
}

function renderRoutingConfig (config) {
  document.getElementById('routing-fast-count').textContent = config.routingRules?.fast?.keywords?.length || 0;
  document.getElementById('routing-fast-target').textContent = config.routingRules?.fast?.target || 'auto';
  document.getElementById('routing-normal-count').textContent = config.routingRules?.normal?.keywords?.length || 0;
  document.getElementById('routing-normal-target').textContent = config.routingRules?.normal?.target || 'auto';
  document.getElementById('routing-complex-count').textContent = config.routingRules?.complex?.keywords?.length || 0;
  document.getElementById('routing-complex-target').textContent = config.routingRules?.complex?.target || 'auto';

  let strategyHtml = '<div style="margin-bottom: 20px;">';
  config.strategies.forEach(s => {
    const checked = config.currentMode === s.id ? 'checked' : '';
    strategyHtml += `
      <label style="display: flex; align-items: flex-start; gap: 10px; padding: 12px; background: ${config.currentMode === s.id ? '#fffef5' : '#f9fafb'}; border: 1px solid ${config.currentMode === s.id ? '#ffd93d' : '#e5e7eb'}; border-radius: 8px; margin-bottom: 8px; cursor: pointer;">
        <input type="radio" name="routing-mode" value="${s.id}" ${checked} onchange="updateRoutingMode('${s.id}')">
        <div>
          <div style="font-weight: 500;">${s.name}</div>
          <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">${s.desc}</div>
        </div>
      </label>
    `;
  });
  strategyHtml += '</div>';
  document.getElementById('routing-strategy').innerHTML = strategyHtml;

  let modelsHtml = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;">';
  config.agents.forEach(agent => {
    const typeColor = agent.type === 'local' ? '#dbeafe' : '#fce7f3';
    const typeTextColor = agent.type === 'local' ? '#1d4ed8' : '#be185d';
    modelsHtml += `
      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px;">
        <div style="font-weight: 500; margin-bottom: 4px;">${agent.displayName}</div>
        <div style="font-size: 12px; color: #6b7280;">${agent.description}</div>
        <div style="margin-top: 8px;">
          <span style="background: ${typeColor}; color: ${typeTextColor}; padding: 2px 8px; border-radius: 4px; font-size: 11px;">
            ${agent.type === 'local' ? '🖥️ 本地' : '☁️ 云端'}
          </span>
        </div>
      </div>
    `;
  });
  if (config.agents.length === 0) {
    modelsHtml += '<div class="empty-state" style="grid-column: 1/-1; padding: 20px;"><div class="empty-text">暂无启用的模型</div></div>';
  }
  modelsHtml += '</div>';
  document.getElementById('routing-models').innerHTML = modelsHtml;
}

const routingConfig = {};

function updateRoutingMode (mode) {
  routingConfig.mode = mode;
  document.querySelectorAll('input[name="routing-mode"]').forEach(input => {
    input.closest('label').style.background = input.checked ? '#fffef5' : '#f9fafb';
    input.closest('label').style.borderColor = input.checked ? '#ffd93d' : '#e5e7eb';
  });
}

async function saveRoutingConfig () {
  const mode = document.querySelector('input[name="routing-mode"]:checked')?.value || 'parallel';

  try {
    const res = await fetch('/api/routing/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        parallelLimit: 3,
        compareResults: true,
        selectBest: true,
        retryOnFailure: true,
        maxRetries: 2,
        routingRules: {
          fast: { keywords: ['简单', '翻译', '格式化', '注释', 'lint'], target: 'ollama', maxTokens: 500 },
          normal: { keywords: ['写代码', '函数', '类', '模块'], target: 'auto', maxTokens: 2000 },
          complex: { keywords: ['算法', '架构', '设计', '复杂', '系统'], target: 'auto', maxTokens: 10000 }
        }
      })
    });
    const data = await res.json();
    if (data.success) {
      alert('路由配置已保存！');
      loadRoutingConfig();
    } else {
      alert('保存失败: ' + data.message);
    }
  } catch (e) {
    alert('保存失败: ' + e.message);
  }
}

let currentTaskId = null;
let consoleInterval = null;

// ═══════════════ 执行模式 ═══════════════
let currentMode = 'privacy';

function selectMode (mode) {
  currentMode = mode;
  // 新布局：.mode-pill 胶囊开关
  document.querySelectorAll('.mode-pill').forEach(pill => {
    if (pill.dataset.mode === mode) {
      pill.classList.add('mode-pill-active');
    } else {
      pill.classList.remove('mode-pill-active');
    }
  });
}

async function recommendMode () {
  const task = document.getElementById('console-task').value.trim();
  if (!task) {
    document.getElementById('mode-recommend').textContent = '请先输入任务描述';
    return;
  }

  document.getElementById('mode-recommend').textContent = '正在分析...';

  try {
    const res = await fetch('/api/modes/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task })
    });

    const data = await res.json();

    if (data.mode) {
      selectMode(data.mode);
      document.getElementById('mode-recommend').textContent = `💡 ${data.reason}`;
    }
  } catch (e) {
    document.getElementById('mode-recommend').textContent = '推荐失败';
  }
}

async function initConsole () {
  const badge = document.getElementById('console-models-badge');
  if (!badge) return;

  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    const agents = data.agents || [];
    const enabled = agents.filter(a => a.enabled);
    if (enabled.length === 0) {
      badge.innerHTML = '<span style="font-size:11px;color:#dc2626;">⚠️ 无启用模型，请到「模型管理」启用</span>';
      badge.dataset.empty = '1';
    } else {
      badge.dataset.empty = '0';
      badge.innerHTML = enabled.map(a => {
        const name = a.displayName || a.name;
        const tag = a.isLocal ? '本地' : '云端';
        return `<span style="padding:3px 8px;background:#e0e7ff;color:#3730a3;border-radius:10px;font-size:11px;">${name} · ${tag}</span>`;
      }).join('');
    }
  } catch (e) {
    badge.innerHTML = '<span style="font-size:11px;color:#dc2626;">加载失败</span>';
  }
}

async function executeTask () {
  const task = document.getElementById('console-task').value.trim();
  if (!task) {
    alert('请输入任务描述');
    return;
  }

  const badge = document.getElementById('console-models-badge');
  if (badge && badge.dataset.empty === '1') {
    appendChatMessage('system', '⚠️ 当前无启用模型，请到「模型管理」页启用至少一个模型');
    return;
  }

  const constraints = {};
  if (document.getElementById('const-c').checked) constraints.language = 'C语言';
  if (document.getElementById('const-python').checked) constraints.language = 'Python';
  if (document.getElementById('const-console').checked) constraints.platform = '控制台';
  if (document.getElementById('const-web').checked) constraints.platform = 'Web';

  document.getElementById('console-status').className = 'status-badge status-busy';
  document.getElementById('console-status').textContent = '执行中';

  // 在聊天中追加用户指令和任务消息
  const msgId = `task-msg-${Date.now()}`;
  currentTaskMsgId = msgId;
  appendChatMessage('user', escapeHtml(task));
  appendChatMessage('task', '🚀 正在启动任务...', msgId);

  try {
    const res = await fetch('/api/tasks/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        constraints,
        mode: currentMode
      })
    });

    const data = await res.json();

    if (data.success) {
      currentTaskId = data.taskId;
      startPolling(data.taskId);
    } else {
      const msgEl = document.getElementById(msgId);
      if (msgEl) {
        const bubble = msgEl.querySelector('.chat-bubble');
        if (bubble) bubble.innerHTML = `❌ 启动失败: ${escapeHtml(data.message || '未知错误')}`;
      }
      document.getElementById('console-status').className = 'status-badge status-error';
      document.getElementById('console-status').textContent = '失败';
    }
  } catch (e) {
    const msgEl = document.getElementById(msgId);
    if (msgEl) {
      const bubble = msgEl.querySelector('.chat-bubble');
      if (bubble) bubble.innerHTML = `❌ 网络错误: ${escapeHtml(e.message)}`;
    }
    document.getElementById('console-status').className = 'status-badge status-error';
    document.getElementById('console-status').textContent = '失败';
  }
}

function startPolling (taskId) {
  if (consoleInterval) clearInterval(consoleInterval);

  consoleInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/status`);
      const data = await res.json();

      if (data.error) {
        clearInterval(consoleInterval);
        return;
      }

      updateConsoleOutput(data);

      if (data.status === 'completed' || data.status === 'failed') {
        clearInterval(consoleInterval);
        consoleInterval = null;

        if (data.status === 'completed') {
          document.getElementById('console-status').className = 'status-badge status-online';
          document.getElementById('console-status').textContent = '完成';
          updateOutputFiles(data.files || []);
          currentTaskMsgId = null;
        } else {
          document.getElementById('console-status').className = 'status-badge status-error';
          document.getElementById('console-status').textContent = '失败';
        }
      }
    } catch (e) {
      console.error('轮询错误:', e);
    }
  }, 2000);
}

function updateConsoleOutput (data) {
  const msgEl = document.getElementById(currentTaskMsgId);
  if (!msgEl) return;

  const bubble = msgEl.querySelector('.chat-bubble');
  if (!bubble) return;

  const output = data.output?.join('') || '';
  let html = '';

  if (data.status === 'running') {
    html += '⏳ 执行中...\n';
  }

  html += output.split('\n').map(line => {
    if (line.startsWith('✅')) {
      return `<span style="color:#059669;">${escapeHtml(line)}</span>`;
    } else if (line.startsWith('❌')) {
      return `<span style="color:#dc2626;">${escapeHtml(line)}</span>`;
    } else if (line.startsWith('⚠️')) {
      return `<span style="color:#d97706;">${escapeHtml(line)}</span>`;
    } else {
      return escapeHtml(line);
    }
  }).join('<br>');

  if (data.progress) {
    html += `<div style="margin-top:12px;color:#6b7280;">进度: ${data.progress}%
      <div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;margin-top:4px;">
        <div style="height:100%;background:#ffd93d;width:${data.progress}%;transition:width 0.3s;"></div>
      </div>
    </div>`;
  }

  bubble.innerHTML = html;
  const outputEl = document.getElementById('console-output');
  if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
}

function updateOutputFiles (files) {
  const container = document.getElementById('output-files');
  const countEl = document.getElementById('file-count');

  if (!files || files.length === 0) {
    container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1; padding: 20px;"><div class="empty-text">暂无生成文件</div></div>';
    countEl.textContent = '0 个文件';
    return;
  }

  countEl.textContent = `${files.length} 个文件`;

  container.innerHTML = files.map(f => {
    const relPath = (f.path || f.name).replace(/\\/g, '/');
    const fileName = f.name || (relPath.split('/').pop() || relPath);
    return `
    <div class="output-file-card" data-path="${escapeHtml(relPath)}">
      <div class="file-name">${fileIconFor(fileName)} ${escapeHtml(fileName)}</div>
      <div style="font-size: 11px; color: #6b7280;">
        ${formatSize(f.size || 0)} | ${f.modified ? new Date(f.modified).toLocaleString() : '-'}
      </div>
      ${relPath ? `<div style="font-size:10px;color:#9ca3af;word-break:break-all;">${escapeHtml(relPath)}</div>` : ''}
      <div class="file-actions">
        ${relPath ? `<button class="btn" style="font-size: 11px; padding: 3px 8px;" onclick="viewFile('${escapeHtml(relPath)}')">👁️ 查看</button>` : ''}
        ${relPath ? `<button class="btn" style="font-size: 11px; padding: 3px 8px;" onclick="downloadOne('${escapeHtml(relPath)}')">📥 下载</button>` : ''}
        ${relPath ? `<button class="btn" style="font-size: 11px; padding: 3px 8px;" onclick="editInFiles('${escapeHtml(relPath)}')">✏️ 编辑</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function downloadOne (relPath) {
  const a = document.createElement('a');
  a.href = `/api/files/download?path=${encodeURIComponent(relPath)}`;
  a.download = '';
  a.click();
}

function editInFiles (relPath) {
  // 跳到文件管理页面并打开该文件
  switchPage('files');
  const idx = relPath.lastIndexOf('/');
  if (idx > 0) {
    const dir = relPath.slice(0, idx);
    document.getElementById('files-path').value = dir;
    filesCurrentPath = dir;
    filesRefresh().then(() => setTimeout(() => filesOpenFile(relPath), 200));
  } else {
    filesRefresh().then(() => setTimeout(() => filesOpenFile(relPath), 200));
  }
}

function escapeHtml (text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function clearConsole () {
  document.getElementById('console-task').value = '';
  clearOutput();
  document.getElementById('output-files').innerHTML = `
    <div class="empty-state" style="grid-column:1/-1;padding:16px;"><div class="empty-text" style="font-size:12px;">暂无生成文件</div></div>`;
  document.getElementById('file-count').textContent = '0 个';
  uploadedFiles = [];
  renderUploadList();
  updateTaskEditor();
  currentTaskId = null;
}

function downloadOutput () {
  const outputEl = document.getElementById('console-output');
  const text = outputEl.innerText;

  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qidi_output_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function viewFile (path) {
  fetch(`/api/files/view?path=${encodeURIComponent(path)}`)
    .then(res => res.text())
    .then(content => {
      const modal = document.getElementById('report-modal');
      document.getElementById('modal-title').textContent = path.split('/').pop();
      document.getElementById('modal-content').textContent = content;
      modal.style.display = 'flex';
    })
    .catch(e => alert('无法加载文件: ' + e.message));
}

function formatNumber (n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatSize (bytes) {
  if (!bytes) return '0B';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return bytes + 'B';
}

function formatDate (timestamp) {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function truncate (str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.substring(0, len) + '...';
}

function getStatusText (status) {
  const map = {
    online: '在线',
    offline: '离线',
    error: '错误',
    connecting: '连接中'
  };
  return map[status] || status || '未知';
}

function getAgentStatusText (status) {
  const map = {
    active: '活跃',
    idle: '空闲',
    busy: '忙碌',
    error: '错误',
    offline: '离线'
  };
  return map[status] || status || '未知';
}

function getTaskStatusText (status) {
  const map = {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    pending: '等待中',
    paused: '已暂停'
  };
  return map[status] || status || '未知';
}

// ═══════════════════════════════════════════════════════════════
// 编程控制台增强：行号编辑器、模板、上传、复制、存为任务
// ═══════════════════════════════════════════════════════════════

const TASK_TEMPLATES = [
  { icon: '🐍', label: 'Web 服务器', text: '用 Python 写一个支持静态文件和 /api/time 接口的 Web 服务器，端口 8080' },
  { icon: '🎮', label: '贪吃蛇', text: '用 C 语言写一个贪吃蛇游戏，支持键盘控制、计分、撞墙死亡' },
  { icon: '🌐', label: 'REST API', text: '用 Node.js + Express 写一个待办事项 REST API，支持增删改查，内存存储' },
  { icon: '🧮', label: '排序算法', text: '用 Python 实现快排、归并、堆排序，并写一个对比基准测试' },
  { icon: '📄', label: '爬虫', text: '用 Python 写一个爬虫，抓取某新闻网站首页标题和链接，保存为 JSON' },
  { icon: '🧪', label: '单元测试', text: '为一个给定的字符串工具类写完整的单元测试（含边界用例）' }
];

let multilineMode = false;
let uploadedFiles = []; // [{name, content, size}]
let currentEditFile = null;
let filesEditorDirty = false; // 编辑器脏标记 // 当前在文件管理页面打开的文件路径

function initTaskTemplates () {
  // 新布局：模板放进 popover
  const pop = document.getElementById('chat-tpl-popover');
  if (pop) {
    pop.innerHTML = TASK_TEMPLATES.map((t, i) =>
      `<div class="chat-tpl-item" onclick="applyTemplate(${i})"><span class="tpl-icon">${t.icon}</span><span>${t.label}</span></div>`
    ).join('');
  }
}

function toggleTplPopover () {
  const pop = document.getElementById('chat-tpl-popover');
  if (!pop) return;
  pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
}

function applyTemplate (i) {
  const t = TASK_TEMPLATES[i];
  if (!t) return;
  document.getElementById('console-task').value = t.text;
  updateTaskEditor();
  const pop = document.getElementById('chat-tpl-popover');
  if (pop) pop.style.display = 'none';
}

function updateTaskEditor () {
  const ta = document.getElementById('console-task');
  if (!ta) return;
  const text = ta.value;
  // 字数
  const cc = document.getElementById('task-char-count');
  if (cc) cc.textContent = `${text.length} 字`;
  // 自适应高度
  ta.style.height = 'auto';
  ta.style.height = Math.min(200, Math.max(44, ta.scrollHeight)) + 'px';
  // 按钮启用态
  const send = document.getElementById('chat-send-btn');
  if (send) send.disabled = text.trim().length === 0;
  const exec = document.getElementById('chat-exec-btn');
  if (exec) exec.disabled = text.trim().length === 0;
}

function toggleMultiline () {
  multilineMode = !multilineMode;
  const ta = document.getElementById('console-task');
  if (multilineMode) {
    ta.placeholder = '多行模式：自由换行，最后点「发送」提交全部内容';
  } else {
    ta.placeholder = '描述任务，Enter 发送 · Shift+Enter 换行 · 拖入/粘贴文件自动上传';
  }
}

// 拖拽 + 粘贴 上传（绑定到输入框容器）
function initUploadDropZone () {
  const wrap = document.getElementById('chat-input-wrap');
  if (!wrap) return;
  ['dragenter', 'dragover'].forEach(ev => {
    wrap.addEventListener(ev, e => {
      e.preventDefault();
      wrap.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    wrap.addEventListener(ev, e => {
      e.preventDefault();
      wrap.classList.remove('dragover');
    });
  });
  wrap.addEventListener('drop', e => {
    const files = e.dataTransfer?.files;
    if (files && files.length) handleUploadedFiles(files);
  });
  // 粘贴文件（截图/复制文件）自动上传
  const ta = document.getElementById('console-task');
  if (ta) {
    ta.addEventListener('paste', e => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const fileItems = [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) fileItems.push(f);
        }
      }
      if (fileItems.length > 0) {
        e.preventDefault();
        handleUploadedFiles(fileItems);
      }
    });
  }
  // ＋ 按钮触发文件选择
  const addBtn = document.getElementById('chat-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      document.getElementById('task-file-input').click();
    });
  }
  // ⚡ 模板按钮切换气泡
  const tplBtn = document.getElementById('chat-tpl-btn');
  if (tplBtn) {
    tplBtn.addEventListener('click', toggleTplPopover);
  }
  // 点击气泡外关闭
  document.addEventListener('click', e => {
    const pop = document.getElementById('chat-tpl-popover');
    const tplBtn = document.getElementById('chat-tpl-btn');
    if (pop && pop.style.display === 'block' &&
        !pop.contains(e.target) && e.target !== tplBtn) {
      pop.style.display = 'none';
    }
  });
}

function onFileSelected (event) {
  const files = event.target.files;
  if (files && files.length) handleUploadedFiles(files);
  event.target.value = '';
}

function handleUploadedFiles (fileList) {
  const arr = Array.from(fileList);
  arr.forEach(f => {
    if (f.size > 2 * 1024 * 1024) {
      alert(`文件 ${f.name} 超过 2MB，已跳过`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      uploadedFiles.push({ name: f.name, content: reader.result, size: f.size });
      renderUploadList();
    };
    reader.onerror = () => alert(`读取 ${f.name} 失败`);
    reader.readAsText(f);
  });
}

function renderUploadList () {
  const wrap = document.getElementById('upload-list');
  if (!wrap) return;
  if (uploadedFiles.length === 0) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    const addBtn = document.getElementById('chat-add-btn');
    if (addBtn) addBtn.classList.remove('has-attachments');
    return;
  }
  wrap.style.display = 'flex';
  wrap.innerHTML = uploadedFiles.map((f, i) =>
    `<span class="chat-attachment">📄 ${escapeHtml(f.name)} <span style="color:#9ca3af;">${formatSize(f.size)}</span><span class="remove" onclick="removeUpload(${i})">✕</span></span>`
  ).join('');
  const addBtn = document.getElementById('chat-add-btn');
  if (addBtn) addBtn.classList.add('has-attachments');
}

function clearOutput () {
  conversationHistory = [];
  currentTaskMsgId = null;
  customSystemPrompt = null;
  chatSessionId = null;
  document.getElementById('console-output').innerHTML = `
    <div class="chat-empty">
      <div class="chat-empty-icon">🤖</div>
      <div class="chat-empty-title">Agent 待命</div>
      <div class="chat-empty-desc">在下方输入框描述需求，与 AI 对话沟通后点击「执行任务」按钮运行<br>支持拖入文件 / 粘贴文件 / 点击 ＋ 上传参考</div>
    </div>`;
  document.getElementById('console-status').className = 'status-badge status-idle';
  document.getElementById('console-status').textContent = '空闲';
  // 重置上下文用量指示器
  const bar = document.getElementById('context-usage-bar');
  const text = document.getElementById('context-usage-text');
  if (bar) bar.style.width = '0%';
  if (text) text.textContent = '';
  // 清除 localStorage 的对话缓存
  try {
    localStorage.removeItem('qidi_chat_history');
  } catch (_) {}
}

function toggleOutputFiles () {
  const body = document.getElementById('output-files-body');
  const toggle = document.getElementById('output-files-toggle');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (toggle) toggle.textContent = open ? '展开 ▾' : '收起 ▴';
}

// Agent 页底部：工具管理折叠区
function toggleToolsPanel () {
  const body = document.getElementById('tools-panel-body');
  const toggle = document.getElementById('tools-panel-toggle');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (toggle) toggle.textContent = open ? '展开 ▾' : '收起 ▴';
  // 首次展开自动加载工具列表
  if (!open && !body.dataset.loaded) {
    loadTools();
    body.dataset.loaded = '1';
  }
}

// 文件与报告页：tab 切换
function switchFilesTab (tab) {
  currentFilesTab = tab;
  const filesBtn = document.getElementById('tab-files-btn');
  const reportsBtn = document.getElementById('tab-reports-btn');
  const filesView = document.getElementById('files-view');
  const reportsView = document.getElementById('reports-view');
  if (!filesView || !reportsView) return;
  if (tab === 'files') {
    filesBtn.classList.add('tab-pill-active');
    reportsBtn.classList.remove('tab-pill-active');
    filesView.style.display = '';
    reportsView.style.display = 'none';
    filesRefresh();
  } else {
    reportsBtn.classList.add('tab-pill-active');
    filesBtn.classList.remove('tab-pill-active');
    filesView.style.display = 'none';
    reportsView.style.display = '';
    loadReports();
  }
}

function removeUpload (i) {
  uploadedFiles.splice(i, 1);
  renderUploadList();
}

async function loadFileIntoTask () {
  // 简易：让用户输入路径，载入到任务描述
  const p = prompt('输入工作目录中的相对路径（例如 task_xxx/main.py）：');
  if (!p) return;
  try {
    const res = await fetch(`/api/files/read?path=${encodeURIComponent(p)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      alert('载入失败: ' + (err.error || res.status));
      return;
    }
    const data = await res.json();
    if (data.binary) {
      alert('二进制文件不能载入到任务描述');
      return;
    }
    document.getElementById('console-task').value =
      `请基于以下已有文件 ${p} 改进：\n\n\`\`\`\n${data.content}\n\`\`\`\n\n我的需求：`;
    updateTaskEditor();
  } catch (e) {
    alert('载入失败: ' + e.message);
  }
}

async function saveTaskToWorkspace () {
  const text = document.getElementById('console-task').value.trim();
  if (!text) {
    alert('任务描述为空');
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const relPath = `tasks/task_${ts}.md`;
  try {
    const res = await fetch('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath, content: `# 任务\n\n${text}\n` })
    });
    const data = await res.json();
    if (data.success) {
      alert(`已保存到 ${relPath}`);
    } else {
      alert('保存失败: ' + (data.error || '未知错误'));
    }
  } catch (e) {
    alert('保存失败: ' + e.message);
  }
}

function copyOutput () {
  const text = document.getElementById('console-output').innerText;
  navigator.clipboard.writeText(text).then(
    () => alert('已复制到剪贴板'),
    () => alert('复制失败，请手动选择文本')
  );
}

// 聊天：发送消息给 AI
async function sendMessage () {
  const ta = document.getElementById('console-task');
  const text = ta.value.trim();
  if (!text) return;

  ta.value = '';
  updateTaskEditor();

  // 处理 /角色 命令：设定自定义身份
  if (text.startsWith('/角色 ')) {
    const roleDesc = text.slice(4).trim();
    if (roleDesc) {
      customSystemPrompt = roleDesc;
      appendChatMessage('system', `✅ 身份已更新为：${escapeHtml(roleDesc)}`);
      conversationHistory = [];
    }
    return;
  }

  // 处理 /帮助 命令：介绍功能
  if (text === '/帮助' || text === '/help') {
    customSystemPrompt = null;
    conversationHistory = [];
    appendChatMessage('system', '⏳ 正在获取功能介绍...');
    const thinkingId = `thinking-${Date.now()}`;
    appendChatMessage('assistant', '🤔 思考中...', thinkingId);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '你是谁？请介绍一下你的功能' }]
        })
      });
      const data = await res.json();
      const thinkingEl = document.getElementById(thinkingId);
      if (thinkingEl) thinkingEl.remove();
      if (data.success) {
        conversationHistory.push({ role: 'user', content: '你是谁？请介绍一下你的功能' });
        conversationHistory.push({ role: 'assistant', content: data.content });
        const displayText = data.content + (data.model ? `<div style="font-size:10px;color:#9ca3af;margin-top:6px;">—— ${escapeHtml(data.model)}</div>` : '');
        appendChatMessage('assistant', displayText);
      } else {
        appendChatMessage('system', `❌ ${escapeHtml(data.message)}`);
      }
    } catch (e) {
      const thinkingEl = document.getElementById(thinkingId);
      if (thinkingEl) thinkingEl.remove();
      appendChatMessage('system', `❌ 网络错误: ${escapeHtml(e.message)}`);
    }
    return;
  }

  // 正常对话
  conversationHistory.push({ role: 'user', content: text });
  appendChatMessage('user', escapeHtml(text));

  const thinkingId = `thinking-${Date.now()}`;
  appendChatMessage('assistant', '🤔 思考中...', thinkingId);

  try {
    const body = { messages: conversationHistory };
    if (customSystemPrompt) {
      body.options = { systemPrompt: customSystemPrompt };
    }
    if (chatSessionId) {
      body.sessionId = chatSessionId;
    }

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    const thinkingEl = document.getElementById(thinkingId);
    if (thinkingEl) thinkingEl.remove();

    if (data.success) {
      // 保存会话 ID 用于持续对话
      if (data.sessionId) chatSessionId = data.sessionId;

      conversationHistory.push({ role: 'assistant', content: data.content });
      const displayText = data.content + (data.model ? `<div style="font-size:10px;color:#9ca3af;margin-top:6px;">—— ${escapeHtml(data.model)}</div>` : '');
      appendChatMessage('assistant', displayText);

      // 更新上下文用量指示器
      if (data.usage) {
        updateContextUsage(data.usage);
      }

      // 持久化到 localStorage
      saveChatToStorage();
    } else {
      appendChatMessage('system', `❌ ${escapeHtml(data.message)}`);
    }
  } catch (e) {
    const thinkingEl = document.getElementById(thinkingId);
    if (thinkingEl) thinkingEl.remove();
    appendChatMessage('system', `❌ 网络错误: ${escapeHtml(e.message)}`);
  }
}

// 在输出区追加一条消息气泡
function appendChatMessage (role, content, msgId) {
  const outputEl = document.getElementById('console-output');

  // 移除空状态占位
  const emptyEl = outputEl.querySelector('.chat-empty');
  if (emptyEl) emptyEl.remove();

  const div = document.createElement('div');
  div.className = `chat-msg chat-msg-${role}`;
  if (msgId) div.id = msgId;

  if (role === 'user') {
    div.innerHTML = `<div class="chat-bubble">${content}</div><div class="chat-avatar">👤</div>`;
  } else if (role === 'assistant') {
    div.innerHTML = `<div class="chat-avatar">🤖</div><div class="chat-bubble">${content}</div>`;
  } else if (role === 'task') {
    div.innerHTML = `<div class="chat-bubble">${content}</div>`;
  } else {
    div.innerHTML = `<div class="chat-bubble">${content}</div>`;
  }

  outputEl.appendChild(div);
  outputEl.scrollTop = outputEl.scrollHeight;
}

// ===== 上下文记忆与持久化 =====

/** 从 localStorage 恢复聊天记录 */
function restoreChatFromStorage () {
  try {
    const saved = localStorage.getItem('qidi_chat_history');
    if (!saved) return;
    const parsed = JSON.parse(saved);
    if (!parsed.history || !Array.isArray(parsed.history) || parsed.history.length === 0) return;

    conversationHistory = parsed.history;
    chatSessionId = parsed.sessionId || null;
    customSystemPrompt = parsed.customPrompt || null;

    // 渲染到界面
    const outputEl = document.getElementById('console-output');
    if (!outputEl) return;
    // 清除空状态占位
    outputEl.innerHTML = '';
    for (const msg of conversationHistory) {
      appendChatMessage(msg.role, escapeHtml(msg.content));
    }
  } catch (_) {}
}

/** 保存聊天记录到 localStorage */
function saveChatToStorage () {
  try {
    localStorage.setItem('qidi_chat_history', JSON.stringify({
      history: conversationHistory,
      sessionId: chatSessionId,
      customPrompt: customSystemPrompt,
      savedAt: new Date().toISOString()
    }));
  } catch (_) {}
}

/** 更新上下文用量指示器 */
function updateContextUsage (usage) {
  const bar = document.getElementById('context-usage-bar');
  const text = document.getElementById('context-usage-text');
  if (!bar || !text) return;

  const pct = Math.min(100, Math.round((usage.promptTokens / usage.contextLimit) * 100));
  bar.style.width = `${pct}%`;

  // 颜色随使用率变化
  if (pct > 90) {
    bar.style.background = '#dc2626';
  } else if (pct > 70) {
    bar.style.background = '#d97706';
  } else {
    bar.style.background = '#6366f1';
  }

  const parts = [
    `上下文: ${pct}%`,
    `(${usage.promptTokens}/${usage.contextLimit} tokens)`
  ];
  if (usage.truncatedCount > 0) {
    parts.push(`已截断 ${usage.truncatedCount} 条旧消息`);
  }
  text.textContent = parts.join(' · ');
}

// 执行任务（附带上传文件）
async function executeTaskWithFiles () {
  // 先把上传文件写入工作目录 uploads/
  if (uploadedFiles.length > 0) {
    try {
      await fetch('/api/files/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'uploads',
          files: uploadedFiles.map(f => ({ name: f.name, content: f.content }))
        })
      });
    } catch (_) { /* ignore upload error */ }
  }
  try {
    return await executeTask();
  } catch (e) {
    console.error('executeTaskWithFiles error:', e);
    appendChatMessage('system', `❌ 提交异常: ${escapeHtml(e.message)}`);
  }
}

async function downloadAllOutputFiles () {
  // 简易：依次下载当前任务输出文件
  const cards = document.querySelectorAll('#output-files .output-file-card');
  if (cards.length === 0) {
    alert('暂无文件');
    return;
  }
  cards.forEach(card => {
    const p = card.getAttribute('data-path');
    if (p) {
      const a = document.createElement('a');
      a.href = `/api/files/download?path=${encodeURIComponent(p)}`;
      a.download = '';
      a.click();
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// 文件管理页面
// ═══════════════════════════════════════════════════════════════

let filesCurrentPath = '.';
let filesCurrentListing = [];

async function filesRefresh () {
  const pathInput = document.getElementById('files-path');
  filesCurrentPath = (pathInput?.value || '.').trim() || '.';
  const recursive = document.getElementById('files-recursive')?.checked ? '1' : '0';
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(filesCurrentPath)}&recursive=${recursive}`);
    const data = await res.json();
    renderFilesList(data);
  } catch (e) {
    alert('加载文件列表失败: ' + e.message);
  }
}

function renderFilesList (data) {
  const list = document.getElementById('files-list');
  const countEl = document.getElementById('files-count');
  if (!data.exists) {
    list.innerHTML = '<div class="empty-state" style="padding:30px;"><div class="empty-text">路径不存在</div></div>';
    if (countEl) countEl.textContent = '0 项';
    filesCurrentListing = [];
    return;
  }
  if (data.type === 'file') {
    // 单文件点击直接打开
    filesOpenFile(data.path);
    list.innerHTML = `<div class="file-entry active"><span class="file-icon">📄</span>${escapeHtml(data.path)}</div>`;
    if (countEl) countEl.textContent = '1 项';
    return;
  }
  const entries = data.entries || [];
  filesCurrentListing = entries;
  if (countEl) countEl.textContent = `${entries.length} 项`;

  // 父目录快捷
  let html = '';
  if (filesCurrentPath !== '.' && filesCurrentPath !== '') {
    html += '<div class="file-entry" onclick="filesGotoParent()"><span class="file-icon">⬆️</span>..</div>';
  }
  html += entries.map(e => {
    const icon = e.type === 'dir' ? '📁' : fileIconFor(e.name);
    const size = e.type === 'file' ? `<span class="file-size">${formatSize(e.size || 0)}</span>` : '';
    return `<div class="file-entry" data-path="${escapeHtml(e.path)}" data-type="${e.type}" onclick="filesEntryClick('${escapeHtml(e.path)}','${e.type}')">
      <span class="file-icon">${icon}</span><span>${escapeHtml(e.name)}</span>${size}
    </div>`;
  }).join('');
  list.innerHTML = html || '<div class="empty-state" style="padding:30px;"><div class="empty-text">空目录</div></div>';
}

function filesGotoParent () {
  const p = filesCurrentPath;
  if (p === '.' || p === '') {
    filesCurrentPath = '.';
  } else {
    const idx = p.lastIndexOf('/');
    filesCurrentPath = idx < 0 ? '.' : p.slice(0, idx) || '.';
  }
  document.getElementById('files-path').value = filesCurrentPath;
  filesRefresh();
}

function filesEntryClick (relPath, type) {
  if (type === 'dir') {
    document.getElementById('files-path').value = relPath;
    filesCurrentPath = relPath;
    filesRefresh();
  } else {
    filesOpenFile(relPath);
  }
}

function fileIconFor (name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const map = {
    js: '📜',
    mjs: '📜',
    cjs: '📜',
    ts: '📜',
    tsx: '📜',
    jsx: '📜',
    py: '🐍',
    c: '🔧',
    cpp: '🔧',
    h: '🔧',
    java: '☕',
    go: '🐹',
    rs: '🦀',
    json: '🗂️',
    md: '📘',
    txt: '📄',
    html: '🌐',
    css: '🎨',
    yml: '⚙️',
    yaml: '⚙️',
    png: '🖼️',
    jpg: '🖼️',
    jpeg: '🖼️',
    gif: '🖼️',
    svg: '🖼️',
    pdf: '📕',
    zip: '📦',
    sql: '🗄️'
  };
  return map[ext] || '📄';
}

async function filesOpenFile (relPath) {
  try {
    const res = await fetch(`/api/files/read?path=${encodeURIComponent(relPath)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      alert('打开失败: ' + (err.error || res.status));
      return;
    }
    const data = await res.json();
    currentEditFile = data;

    document.getElementById('files-editor-empty').style.display = 'none';
    const wrap = document.getElementById('files-editor-wrap');
    wrap.style.display = 'block';
    const editor = document.getElementById('files-editor');
    if (data.binary) {
      editor.value = '⚠️ 二进制文件，无法编辑（可下载）';
      editor.disabled = true;
      document.getElementById('files-save-btn').disabled = true;
    } else {
      editor.value = data.content || '';
      editor.disabled = false;
      document.getElementById('files-save-btn').disabled = false;
    }
    document.getElementById('files-editor-title').textContent = `📄 ${data.path}`;
    document.getElementById('files-editor-meta').textContent =
      `${formatSize(data.size)} · ${data.lang || 'text'} · ${new Date(data.modified).toLocaleString()}`;
    document.getElementById('files-download-btn').disabled = false;
    document.getElementById('files-delete-btn').disabled = false;

    // 高亮当前文件
    document.querySelectorAll('.file-entry').forEach(el => el.classList.remove('active'));
    const cur = document.querySelector(`.file-entry[data-path="${CSS.escape(relPath)}"]`);
    if (cur) cur.classList.add('active');

    filesUpdateGutter();
    filesEditorDirty = false; // 打开文件时重置脏标记
    updateFilesEditorStatus();
  } catch (e) {
    alert('打开失败: ' + e.message);
  }
}

function filesUpdateGutter () {
  const editor = document.getElementById('files-editor');
  const gutter = document.getElementById('files-editor-gutter');
  if (!editor || !gutter) return;
  const lines = editor.value.split('\n').length;
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
}

function updateFilesEditorStatus () {
  const statusEl = document.getElementById('files-editor-status');
  if (!statusEl) return;
  if (filesEditorDirty) {
    statusEl.textContent = '⚠️ 有未保存的更改';
    statusEl.style.color = '#e67e22';
  } else if (currentEditFile) {
    statusEl.textContent = '✅ 已保存';
    statusEl.style.color = '#27ae60';
  } else {
    statusEl.textContent = '未打开文件';
    statusEl.style.color = '#7f8c8d';
  }
}

async function filesEditorSave () {
  if (!currentEditFile || currentEditFile.binary) return;
  const content = document.getElementById('files-editor').value;
  try {
    const res = await fetch('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentEditFile.path, content })
    });
    const data = await res.json();
    if (data.success) {
      filesEditorDirty = false;
      updateFilesEditorStatus();
      filesRefresh();
    } else {
      alert('保存失败: ' + (data.error || '未知'));
    }
  } catch (e) {
    alert('保存失败: ' + e.message);
  }
}

function filesEditorDownload () {
  if (!currentEditFile) return;
  const a = document.createElement('a');
  a.href = `/api/files/download?path=${encodeURIComponent(currentEditFile.path)}`;
  a.download = '';
  a.click();
}

async function filesEditorDelete () {
  if (!currentEditFile) return;
  if (!confirm(`确定删除 ${currentEditFile.path}？`)) return;
  try {
    const res = await fetch('/api/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentEditFile.path })
    });
    const data = await res.json();
    if (data.success) {
      alert('已删除');
      filesCloseEditor();
      filesRefresh();
    } else {
      alert('删除失败: ' + (data.error || '未知'));
    }
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}

function filesCloseEditor () {
  // 如果有未保存的更改，提示用户
  if (filesEditorDirty) {
    if (!confirm('有未保存的更改，确定要关闭吗？')) return;
  }
  currentEditFile = null;
  filesEditorDirty = false;
  document.getElementById('files-editor-empty').style.display = '';
  document.getElementById('files-editor-wrap').style.display = 'none';
  document.getElementById('files-save-btn').disabled = true;
  document.getElementById('files-download-btn').disabled = true;
  document.getElementById('files-delete-btn').disabled = true;
  updateFilesEditorStatus();
}

function filesNewFile () {
  const name = prompt('新文件相对路径（例如 notes/todo.md）：');
  if (!name) return;
  fetch('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: name, content: '' })
  }).then(r => r.json()).then(d => {
    if (d.success) {
      // 进入该文件所在目录并打开
      const idx = name.lastIndexOf('/');
      if (idx > 0) {
        document.getElementById('files-path').value = name.slice(0, idx);
      }
      filesRefresh().then(() => filesOpenFile(name));
    } else {
      alert('创建失败: ' + (d.error || '未知'));
    }
  }).catch(e => alert('创建失败: ' + e.message));
}

function filesNewDir () {
  const name = prompt('新目录相对路径：');
  if (!name) return;
  fetch('/api/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: name })
  }).then(r => r.json()).then(d => {
    if (d.success) {
      document.getElementById('files-path').value = name;
      filesRefresh();
    } else {
      alert('创建失败: ' + (d.error || '未知'));
    }
  }).catch(e => alert('创建失败: ' + e.message));
}

function filesUploadClick () {
  document.getElementById('files-upload-input').click();
}

function filesOnUpload (event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;

  // 显示上传进度
  const statusDiv = document.getElementById('files-upload-status');
  if (statusDiv) {
    statusDiv.style.display = 'block';
    statusDiv.innerHTML = `<div style="margin-bottom:4px;font-size:12px;">正在上传 ${files.length} 个文件...</div><div style="background:#e5e7eb;border-radius:4px;height:8px;"><div id="files-upload-progress" style="background:#3b82f6;height:8px;border-radius:4px;width:0%;transition:width 0.3s;"></div></div>`;
  }

  // 使用 FormData 进行 multipart 上传
  const formData = new FormData();
  for (const f of files) {
    formData.append('files', f);
  }
  if (filesCurrentPath) {
    formData.append('dir', filesCurrentPath);
  }

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/files/upload');
  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable && statusDiv) {
      const pct = Math.round((e.loaded / e.total) * 100);
      const bar = document.getElementById('files-upload-progress');
      if (bar) bar.style.width = pct + '%';
    }
  });
  xhr.addEventListener('load', () => {
    if (statusDiv) statusDiv.style.display = 'none';
    if (xhr.status === 200) {
      const d = JSON.parse(xhr.responseText);
      if (d.success) {
        alert(`已上传 ${d.count || d.uploaded.length} 个文件`);
        filesRefresh();
      } else {
        alert('上传失败: ' + (d.error || '未知'));
      }
    } else {
      alert('上传失败: HTTP ' + xhr.status);
    }
  });
  xhr.addEventListener('error', () => {
    if (statusDiv) statusDiv.style.display = 'none';
    alert('上传失败：网络错误');
  });
  xhr.send(formData);
  event.target.value = '';
}

// ═══════════════════════════════════════════════════════════════
// 初始化（DOMContentLoaded 之外，独立绑定）
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initTaskTemplates();
  initUploadDropZone();

  // 任务输入框：自适应高度 + 回车提交 + Tab 缩进
  const ta = document.getElementById('console-task');
  if (ta) {
    ta.addEventListener('input', updateTaskEditor);
    ta.addEventListener('keydown', e => {
      // Enter 发送聊天，Shift+Enter 换行；多行模式下 Enter 换行
      if (e.key === 'Enter' && !e.shiftKey && !multilineMode) {
        e.preventDefault();
        sendMessage();
        return;
      }
      // Ctrl+Enter 直接执行任务
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        executeTaskWithFiles();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart; const en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        updateTaskEditor();
      }
    });
    updateTaskEditor();
  }

  // 文件编辑器：联动行号 + 脏标记 + 状态栏
  const fe = document.getElementById('files-editor');
  if (fe) {
    fe.addEventListener('input', () => {
      filesUpdateGutter();
      filesEditorDirty = true;
      updateFilesEditorStatus();
    });
    fe.addEventListener('keyup', filesUpdateGutter);
    fe.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = fe.selectionStart; const en = fe.selectionEnd;
        fe.value = fe.value.slice(0, s) + '  ' + fe.value.slice(en);
        fe.selectionStart = fe.selectionEnd = s + 2;
        filesUpdateGutter();
      }
      // Ctrl+S 保存
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        filesEditorSave();
      }
    });
  }

  // 遗留兼容：旧布局中替换执行按钮（新布局已直接绑定 executeTaskWithFiles）
  const execBtn = document.querySelector('#page-console .btn-primary[onclick="executeTask()"]');
  if (execBtn) {
    execBtn.setAttribute('onclick', 'executeTaskWithFiles()');
  }
});
