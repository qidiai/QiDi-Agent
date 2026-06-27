let currentPage = 'dashboard';
let dashboardData = null;
let toolsData = [];
let agentsData = [];
let reportsData = [];
let tokensData = [];

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  loadAllData();
  setInterval(loadDashboard, 30000);
});

function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      switchPage(page);
    });
  });
}

function switchPage(page) {
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
    console: '编程控制台',
    tools: '工具管理',
    agents: '模型管理',
    routing: '智能路由',
    tokens: 'Token 统计',
    reports: '报告中心',
    tasks: '任务管理'
  };
  document.getElementById('page-title').textContent = titles[page] || '仪表盘';

  if (page === 'dashboard') loadDashboard();
  if (page === 'console') initConsole();
  if (page === 'tools') loadTools();
  if (page === 'agents') loadAgents();
  if (page === 'routing') loadRoutingConfig();
  if (page === 'tokens') loadTokens();
  if (page === 'reports') loadReports();
  if (page === 'tasks') loadTasks();
}

async function loadAllData() {
  await loadDashboard();
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/dashboard');
    const data = await res.json();
    dashboardData = data;
    renderDashboard(data);
  } catch (e) {
    console.error('加载仪表盘数据失败:', e);
  }
}

function renderDashboard(data) {
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

function renderToolsPreview(tools) {
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

function renderAgentsPreview(agents) {
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

function renderTokensPreview(tokens) {
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

function renderReportsPreview(reports) {
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

async function loadTools() {
  try {
    const res = await fetch('/api/tools');
    const data = await res.json();
    toolsData = data.tools;
    renderToolsFull(data.tools);
  } catch (e) {
    console.error('加载工具列表失败:', e);
  }
}

function renderToolsFull(tools) {
  const container = document.getElementById('tools-full');
  if (!tools || tools.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔧</div><div class="empty-text">暂无工具</div><div class="empty-desc">点击上方"扫描工具"按钮检测已安装的AI工具</div></div>';
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
        ${tool.detected ? `<span style="color:#10b981;">✓ 已检测</span>` : '<span style="color:#9ca3af;">未检测</span>'}
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

async function scanTools() {
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

async function connectTool(name) {
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

async function viewToolDetail(name) {
  try {
    const res = await fetch(`/api/tools/${name}/detail`);
    const data = await res.json();
    showToolDetailModal(data);
  } catch (e) {
    alert('获取详情失败: ' + e.message);
  }
}

function showToolDetailModal(tool) {
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
    content += `工作文件: 暂无\n`;
  }

  document.getElementById('modal-content').textContent = content;
  modal.style.display = 'flex';
}

async function loadAgents() {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    agentsData = data.agents;
    renderAgentsFull(data.agents);
  } catch (e) {
    console.error('加载模型失败:', e);
  }
}

function renderAgentsFull(agents) {
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

function renderAgentCard(agent) {
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

async function enableAgent(name) {
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

async function disableAgent(name) {
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

function showAddModelModal() {
  document.getElementById('model-modal-title').textContent = '添加模型';
  document.getElementById('model-form').reset();
  document.getElementById('model-name-original').value = '';
  document.getElementById('model-name').disabled = false;
  document.getElementById('model-type').disabled = false;
  document.getElementById('model-modal').style.display = 'flex';
}

function showEditModelModal(name) {
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

function closeModelModal() {
  document.getElementById('model-modal').style.display = 'none';
}

function updateModelDefaults() {
  const type = document.getElementById('model-type').value;
  const baseURLInput = document.getElementById('model-baseurl');
  const modelInput = document.getElementById('model-model');

  const defaults = {
    'openai': { baseURL: 'https://api.openai.com/v1', model: 'gpt-4' },
    'anthropic': { baseURL: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20240620' },
    'ollama': { baseURL: 'http://localhost:11434', model: 'qwen2.5:7b' },
    'custom': { baseURL: '', model: '' }
  };

  if (defaults[type]) {
    if (!baseURLInput.value) baseURLInput.value = defaults[type].baseURL;
    if (!modelInput.value) modelInput.value = defaults[type].model;
  }
}

async function saveModel(event) {
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

async function deleteModel(name) {
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

async function viewAgentDetail(name) {
  try {
    const res = await fetch(`/api/agents/${name}/status`);
    const data = await res.json();
    showAgentDetailModal(data);
  } catch (e) {
    alert('获取详情失败: ' + e.message);
  }
}

function showAgentDetailModal(agent) {
  const modal = document.getElementById('report-modal');
  document.getElementById('modal-title').textContent = `${agent.name} - 智能体详情`;

  let content = `智能体: ${agent.name}\n`;
  content += `状态: ${getAgentStatusText(agent.status)}\n`;
  content += `最后活跃: ${agent.lastActive ? formatDate(agent.lastActive) : '从未活跃'}\n\n`;

  if (agent.currentTask) {
    content += `当前任务: ${agent.currentTask}\n\n`;
  }

  if (agent.tokenUsage) {
    content += `Token消耗统计:\n`;
    content += `  总计: ${formatNumber(agent.tokenUsage.total || 0)}\n`;
    content += `  输入: ${formatNumber(agent.tokenUsage.prompt || 0)}\n`;
    content += `  输出: ${formatNumber(agent.tokenUsage.completion || 0)}\n`;
    if (agent.tokenUsage.calls) {
      content += `  调用次数: ${agent.tokenUsage.calls}\n`;
    }
    content += `\n`;
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
    content += `工作文件: 暂无\n`;
  }

  document.getElementById('modal-content').textContent = content;
  modal.style.display = 'flex';
}

async function loadTokens() {
  try {
    const res = await fetch('/api/tokens');
    const data = await res.json();
    tokensData = data.tokens;
    renderTokensFull(data.tokens);
  } catch (e) {
    console.error('加载Token统计失败:', e);
  }
}

function renderTokensFull(tokens) {
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

async function loadReports() {
  try {
    const res = await fetch('/api/reports?limit=50');
    const data = await res.json();
    reportsData = data.reports;
    renderReportsFull(data.reports);
  } catch (e) {
    console.error('加载报告失败:', e);
  }
}

function renderReportsFull(reports) {
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

function searchReports() {
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

async function viewReport(id) {
  try {
    const res = await fetch(`/api/reports/${id}`);
    const data = await res.json();
    showReportModal(data);
  } catch (e) {
    alert('加载报告失败: ' + e.message);
  }
}

function showReportModal(report) {
  const modal = document.getElementById('report-modal');
  document.getElementById('modal-title').textContent = '实验报告详情';
  document.getElementById('modal-content').textContent = report.content || JSON.stringify(report, null, 2);
  modal.style.display = 'flex';
}

function closeReportModal() {
  document.getElementById('report-modal').style.display = 'none';
}

async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    renderTasksFull(data.tasks);
  } catch (e) {
    console.error('加载任务失败:', e);
  }
}

function renderTasksFull(tasks) {
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
      ${task.progress !== undefined ? `
        <div class="task-progress">
          <div class="task-progress-fill" style="width: ${task.progress}%"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px;text-align:right;">${task.progress}%</div>
      ` : ''}
    </div>
  `).join('');
}

function refreshData() {
  loadAllData();
  const page = currentPage;
  if (page !== 'dashboard') {
    if (page === 'tools') loadTools();
    if (page === 'agents') loadAgents();
    if (page === 'tokens') loadTokens();
    if (page === 'reports') loadReports();
    if (page === 'tasks') loadTasks();
  }
}

async function loadRoutingConfig() {
  try {
    const res = await fetch('/api/routing/config');
    const config = await res.json();
    renderRoutingConfig(config);
  } catch (e) {
    console.error('加载路由配置失败:', e);
  }
}

function renderRoutingConfig(config) {
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

let routingConfig = {};

function updateRoutingMode(mode) {
  routingConfig.mode = mode;
  document.querySelectorAll('input[name="routing-mode"]').forEach(input => {
    input.closest('label').style.background = input.checked ? '#fffef5' : '#f9fafb';
    input.closest('label').style.borderColor = input.checked ? '#ffd93d' : '#e5e7eb';
  });
}

async function saveRoutingConfig() {
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

function selectMode(mode) {
  currentMode = mode;
  
  document.querySelectorAll('.mode-card').forEach(card => {
    const cardMode = card.getAttribute('data-mode');
    if (cardMode === mode) {
      card.classList.add('mode-selected');
      if (mode === 'privacy') {
        card.style.borderColor = '#10b981';
        card.style.background = '#ecfdf5';
        card.querySelector('div:nth-child(2)').style.color = '#065f46';
        card.querySelector('div:nth-child(3)').style.color = '#059669';
      } else {
        card.style.borderColor = '#6366f1';
        card.style.background = '#eef2ff';
        card.querySelector('div:nth-child(2)').style.color = '#3730a3';
        card.querySelector('div:nth-child(3)').style.color = '#4f46e5';
      }
    } else {
      card.classList.remove('mode-selected');
      card.style.borderColor = '#e5e7eb';
      card.style.background = '#fff';
      card.querySelector('div:nth-child(2)').style.color = '#374151';
      card.querySelector('div:nth-child(3)').style.color = '#6b7280';
    }
  });
}

async function recommendMode() {
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

async function initConsole() {
  const modelSelect = document.getElementById('console-model');
  
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    const enabledModels = data.agents.filter(a => a.enabled);
    
    modelSelect.innerHTML = enabledModels.map(a => 
      `<option value="${a.name}">${a.displayName || a.name} ${a.model ? `(${a.model})` : ''}</option>`
    ).join('');
    
    if (enabledModels.length === 0) {
      modelSelect.innerHTML = '<option value="" disabled>没有启用的模型</option>';
    }
  } catch (e) {
    modelSelect.innerHTML = '<option value="" disabled>加载失败</option>';
  }
}

async function executeTask() {
  const task = document.getElementById('console-task').value.trim();
  if (!task) {
    alert('请输入任务描述');
    return;
  }
  
  const modelSelect = document.getElementById('console-model');
  const selectedModels = Array.from(modelSelect.selectedOptions).map(o => o.value);
  
  const constraints = {};
  if (document.getElementById('const-c').checked) constraints.language = 'C语言';
  if (document.getElementById('const-python').checked) constraints.language = 'Python';
  if (document.getElementById('const-console').checked) constraints.platform = '控制台';
  if (document.getElementById('const-web').checked) constraints.platform = 'Web';
  
  document.getElementById('console-status').className = 'status-badge status-busy';
  document.getElementById('console-status').textContent = '执行中';
  
  const outputEl = document.getElementById('console-output');
  outputEl.innerHTML = '<div style="color: #6b7280;">🚀 正在启动任务...\n</div>';
  
  try {
    const res = await fetch('/api/tasks/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        models: selectedModels.length > 0 ? selectedModels : ['ollama'],
        constraints,
        mode: currentMode  // 执行模式
      })
    });
    
    const data = await res.json();
    
    if (data.success) {
      currentTaskId = data.taskId;
      startPolling(data.taskId);
    } else {
      outputEl.innerHTML = `<div style="color: #dc2626;">❌ 启动失败: ${data.message || '未知错误'}</div>`;
      document.getElementById('console-status').className = 'status-badge status-error';
      document.getElementById('console-status').textContent = '失败';
    }
  } catch (e) {
    outputEl.innerHTML = `<div style="color: #dc2626;">❌ 网络错误: ${e.message}</div>`;
    document.getElementById('console-status').className = 'status-badge status-error';
    document.getElementById('console-status').textContent = '失败';
  }
}

function startPolling(taskId) {
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

function updateConsoleOutput(data) {
  const outputEl = document.getElementById('console-output');
  const output = data.output?.join('') || '';
  
  let html = '';
  
  if (data.status === 'running') {
    html += '<div style="color: #6b7280;">⏳ 执行中...</div>\n';
  }
  
  html += output.split('\n').map(line => {
    if (line.startsWith('✅')) {
      return `<div style="color: #059669;">${escapeHtml(line)}</div>`;
    } else if (line.startsWith('❌')) {
      return `<div style="color: #dc2626;">${escapeHtml(line)}</div>`;
    } else if (line.startsWith('⚠️')) {
      return `<div style="color: #d97706;">${escapeHtml(line)}</div>`;
    } else {
      return `<div>${escapeHtml(line)}</div>`;
    }
  }).join('');
  
  if (data.progress) {
    html += `<div style="margin-top: 12px; color: #6b7280;">
      进度: ${data.progress}%
      <div style="height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; margin-top: 4px;">
        <div style="height: 100%; background: #ffd93d; width: ${data.progress}%; transition: width 0.3s;"></div>
      </div>
    </div>`;
  }
  
  outputEl.innerHTML = html;
  outputEl.scrollTop = outputEl.scrollHeight;
}

function updateOutputFiles(files) {
  const container = document.getElementById('output-files');
  const countEl = document.getElementById('file-count');
  
  if (!files || files.length === 0) {
    container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1; padding: 20px;"><div class="empty-text">暂无生成文件</div></div>';
    countEl.textContent = '0 个文件';
    return;
  }
  
  countEl.textContent = `${files.length} 个文件`;
  
  container.innerHTML = files.map(f => `
    <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px;">
      <div style="font-weight: 500; margin-bottom: 4px;">${escapeHtml(f.name)}</div>
      <div style="font-size: 11px; color: #6b7280; margin-bottom: 8px;">
        ${formatSize(f.size)} | ${new Date(f.modified).toLocaleString()}
      </div>
      <button class="btn" style="font-size: 11px; padding: 4px 8px;" onclick="viewFile('${f.path.replace(/\\/g, '/')}')">查看</button>
    </div>
  `).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function clearConsole() {
  document.getElementById('console-task').value = '';
  document.getElementById('console-output').innerHTML = `
    <div class="empty-state" style="padding: 40px;">
      <div class="empty-icon">💻</div>
      <div class="empty-text">等待任务输入</div>
      <div class="empty-desc">在左侧输入任务描述并点击执行</div>
    </div>
  `;
  document.getElementById('console-status').className = 'status-badge status-idle';
  document.getElementById('console-status').textContent = '空闲';
  document.getElementById('output-files').innerHTML = `
    <div class="empty-state" style="grid-column: 1/-1; padding: 20px;">
      <div class="empty-text">暂无生成文件</div>
    </div>
  `;
  document.getElementById('file-count').textContent = '0 个文件';
  currentTaskId = null;
}

function downloadOutput() {
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

function viewFile(path) {
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

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatSize(bytes) {
  if (!bytes) return '0B';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return bytes + 'B';
}

function formatDate(timestamp) {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.substring(0, len) + '...';
}

function getStatusText(status) {
  const map = {
    'online': '在线',
    'offline': '离线',
    'error': '错误',
    'connecting': '连接中'
  };
  return map[status] || status || '未知';
}

function getAgentStatusText(status) {
  const map = {
    'active': '活跃',
    'idle': '空闲',
    'busy': '忙碌',
    'error': '错误',
    'offline': '离线'
  };
  return map[status] || status || '未知';
}

function getTaskStatusText(status) {
  const map = {
    'running': '运行中',
    'completed': '已完成',
    'failed': '失败',
    'pending': '等待中',
    'paused': '已暂停'
  };
  return map[status] || status || '未知';
}