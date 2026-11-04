let appState = {
  waStatus: 'DISCONNECTED',
  groups: [],
  mappings: { rules: [] },
  settings: {},
  history: [],
  filteredHistory: [],
  queue: {},
  currentUser: null,
  usersList: [],
  webhookBaseUrl: 'https://vuvchcevhezkxhmlxgrz.supabase.co/functions/v1/umovme-webhook',
  lightbox: {
    photos: [],
    currentIndex: 0,
    title: '',
    subtitle: ''
  }
};

// =========================================================================
// 0. TEMA ESCURO / CLARO EXECUTIVO (COM PERSISTÊNCIA)
// =========================================================================
function applyTheme(theme) {
  const validTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', validTheme);
  localStorage.setItem('trade_hub_theme', validTheme);
  const btn = document.getElementById('btn-toggle-theme');
  if (btn) {
    btn.innerHTML = validTheme === 'light' ? '🌙 Modo Escuro' : '☀️ Modo Claro';
  }
}

applyTheme(localStorage.getItem('trade_hub_theme') || 'dark');

document.getElementById('btn-toggle-theme')?.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  showToast(next === 'light' ? '☀️ Modo Claro Executivo ativado!' : '🌙 Modo Escuro Objetiva ativado!', 'info');
});

// Interceptor global para enviar o Token de Autenticação em todas as chamadas de API
const originalFetch = window.fetch.bind(window);
window.fetch = async (url, options = {}) => {
  const token = localStorage.getItem('trade_hub_token');
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await originalFetch(url, { ...options, headers });
  if (res.status === 401 && typeof url === 'string' && !url.includes('/api/auth/')) {
    showAuthOverlay();
  }
  return res;
};

// Elements
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const statWaStatus = document.getElementById('stat-wa-status');
const statWaSub = document.getElementById('stat-wa-sub');
const statGroupsCount = document.getElementById('stat-groups-count');
const statActivitiesCount = document.getElementById('stat-activities-count');
const statQueueCount = document.getElementById('stat-queue-count');
const waConnectionView = document.getElementById('wa-connection-view');
const waActions = document.getElementById('wa-connection-actions');
const groupsTableBody = document.getElementById('groups-table-body');
const rulesTableBody = document.getElementById('rules-table-body');
const activityFeedList = document.getElementById('activity-feed-list');

// Toast notification helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Tab Switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    
    btn.classList.add('active');
    const tabId = btn.getAttribute('data-tab');
    document.getElementById(tabId)?.classList.add('active');

    // Auto-carregar dados específicos
    if (tabId === 'tab-groups') loadGroups(true);
    if (tabId === 'tab-mappings') loadMappings();
    if (tabId === 'tab-feed' || tabId === 'tab-ranking') loadHistory();
    if (tabId === 'tab-users') loadUsers();
    if (tabId === 'tab-settings') loadSettings();
  });
});

// =========================================================================
// 1. WHATSAPP STATUS & QR CODE POLLING
// =========================================================================
async function checkWhatsAppStatus() {
  try {
    const res = await fetch('/api/whatsapp/status');
    const data = await res.json();
    appState.waStatus = data.status;

    statusBadge.className = `status-badge ${data.status.toLowerCase()}`;
    
    if (data.status === 'CONNECTED') {
      const userName = data.user?.name || 'WhatsApp';
      statusText.textContent = `Online: ${userName}`;
      statWaStatus.textContent = 'Conectado';
      statWaStatus.style.color = 'var(--accent-wa)';
      if (statWaSub) statWaSub.textContent = `Conta: ${userName}`;
      renderConnectedView(data.user);
    } else if (data.status === 'QR_READY') {
      statusText.textContent = 'Aguardando Leitura QR';
      statWaStatus.textContent = 'Escanear QR';
      statWaStatus.style.color = 'var(--accent-amber)';
      if (statWaSub) statWaSub.textContent = 'Aponte o celular para o QR Code';
      renderQRView(data.qrCodeDataUrl);
    } else if (data.status === 'CONNECTING') {
      statusText.textContent = 'Conectando...';
      statWaStatus.textContent = 'Conectando';
      statWaStatus.style.color = 'var(--accent-blue)';
      if (statWaSub) statWaSub.textContent = 'Sincronizando sessão...';
      renderConnectingView();
    } else {
      statusText.textContent = 'Desconectado';
      statWaStatus.textContent = 'Desconectado';
      statWaStatus.style.color = 'var(--accent-red)';
      if (statWaSub) statWaSub.textContent = 'Clique para gerar QR Code';
      renderDisconnectedView();
    }
  } catch (err) {
    console.error('Erro ao verificar status do WhatsApp:', err);
  }
}

function renderQRView(qrDataUrl) {
  waActions.innerHTML = `
    <button id="btn-reset-wa" class="btn btn-secondary btn-sm">🔄 Gerar Novo QR Code</button>
  `;
  document.getElementById('btn-reset-wa')?.addEventListener('click', () => handleResetSession('Deseja gerar um novo QR Code para ler no celular?'));

  waConnectionView.innerHTML = `
    <div class="qr-container">
      <div class="qr-box">
        ${qrDataUrl ? `<img src="${qrDataUrl}" alt="WhatsApp QR Code">` : '<div class="pulse-dot" style="width:20px;height:20px;margin:2rem auto;"></div><p style="color:#000;">Gerando QR Code...</p>'}
      </div>
      <div class="qr-instructions">
        <h3 style="color: var(--text-main); margin-bottom: 0.5rem;">Como conectar seu WhatsApp:</h3>
        <ol>
          <li>Abra o <strong>WhatsApp</strong> no celular que enviará as fotos nos grupos</li>
          <li>Toque em <strong>Mais opções</strong> (Android) ou <strong>Configurações</strong> (iPhone)</li>
          <li>Selecione <strong>Aparelhos conectados</strong> e depois <strong>Conectar um aparelho</strong></li>
          <li>Aponte a câmera para este QR Code na tela</li>
        </ol>
        <p style="font-size: 0.8rem; color: var(--accent-amber); margin-bottom: 0.8rem;">O QR Code se atualiza automaticamente caso expire.</p>
        <button class="btn btn-secondary btn-sm" onclick="handleResetSession('Deseja limpar as credenciais antigas e conectar outro número de WhatsApp?')">
          🔄 Conectar Outro Número / Resetar
        </button>
      </div>
    </div>
  `;
}

function renderConnectedView(user) {
  waActions.innerHTML = `
    <button id="btn-switch-wa" class="btn btn-warning btn-sm" title="Desconecta este número e gera QR para escanear outro celular">🔄 Conectar Outro WhatsApp</button>
    <button id="btn-logout" class="btn btn-danger btn-sm">🚪 Desconectar</button>
  `;
  document.getElementById('btn-switch-wa')?.addEventListener('click', () => handleResetSession('Deseja desconectar esta conta atual e conectar um novo número de WhatsApp?'));
  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

  waConnectionView.innerHTML = `
    <div class="connected-box">
      <div class="connected-info">
        <div class="avatar">${(user?.name || 'WA').substring(0, 2).toUpperCase()}</div>
        <div>
          <h3 style="font-size: 1.1rem; color: var(--text-main); font-weight: 700;">${escapeHtml(user?.name || 'Conta Conectada')}</h3>
          <p style="font-size: 0.85rem; color: var(--text-muted);">${escapeHtml(user?.id || 'ID Ativo')}</p>
          <span class="badge badge-success" style="margin-top: 0.4rem;">🟢 Ativo para Disparos 24h</span>
        </div>
      </div>
      <div style="display: flex; gap: 0.6rem; flex-wrap: wrap;">
        <button class="btn btn-secondary btn-sm" onclick="document.querySelector('[data-tab=tab-groups]').click()">
          👥 Ver Grupos Disponíveis
        </button>
        <button class="btn btn-warning btn-sm" onclick="handleResetSession('Deseja desconectar esta conta atual e conectar um novo número de WhatsApp?')">
          🔄 Trocar para Outro WhatsApp
        </button>
      </div>
    </div>
  `;
}

function renderConnectingView() {
  waActions.innerHTML = `
    <button id="btn-reset-wa" class="btn btn-secondary btn-sm">🔄 Cancelar e Gerar Novo QR</button>
  `;
  document.getElementById('btn-reset-wa')?.addEventListener('click', () => handleResetSession('Deseja reiniciar a tentativa de conexão e gerar um QR Code novo?'));

  waConnectionView.innerHTML = `
    <div class="qr-container">
      <div class="pulse-dot" style="width: 20px; height: 20px; margin-bottom: 1rem; color: var(--accent-brand);"></div>
      <p style="color: var(--text-main); font-weight: 600;">Estabilizando conexão com o WhatsApp...</p>
      <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.4rem;">Aguarde alguns segundos ou clique em Cancelar para gerar um QR novo.</p>
    </div>
  `;
}

function renderDisconnectedView() {
  waActions.innerHTML = `
    <button id="btn-reset-wa" class="btn btn-primary btn-sm">📲 Conectar WhatsApp (Novo QR)</button>
  `;
  document.getElementById('btn-reset-wa')?.addEventListener('click', () => handleResetSession());

  waConnectionView.innerHTML = `
    <div class="qr-container">
      <p style="color: var(--text-main); font-weight: 600; font-size: 1.05rem;">WhatsApp Desconectado</p>
      <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.4rem; max-width: 420px; margin: 0.4rem auto 1.2rem auto;">
        Nenhum aparelho conectado no momento. Clique no botão abaixo para gerar um QR Code limpo e escanear com qualquer WhatsApp.
      </p>
      <button class="btn btn-primary" onclick="handleResetSession()">
        📲 Gerar QR Code para Conectar WhatsApp
      </button>
    </div>
  `;
}

async function handleResetSession(confirmMessage = 'Deseja desconectar a conta atual e gerar um novo QR Code para conectar outro WhatsApp?') {
  if (confirmMessage && !confirm(confirmMessage)) return;
  try {
    showToast('Limpando sessão antiga e gerando novo QR Code...', 'info');
    const res = await fetch('/api/whatsapp/reset', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Sessão resetada! Aponte o novo WhatsApp para o QR Code gerado.', 'success');
      setTimeout(checkWhatsAppStatus, 1000);
      setTimeout(checkWhatsAppStatus, 3000);
    } else {
      showToast('Erro ao reiniciar sessão.', 'error');
    }
  } catch (err) {
    showToast('Erro ao comunicar com o servidor.', 'error');
  }
}

async function handleLogout() {
  await handleResetSession('Deseja realmente desconectar esta conta de WhatsApp?');
}

// =========================================================================
// 2. GRUPOS DE WHATSAPP & COMUNICADO RÁPIDO
// =========================================================================
async function loadGroups(force = false) {
  try {
    const res = await fetch(`/api/whatsapp/groups${force ? '?force=true' : ''}`);
    const data = await res.json();
    appState.groups = data.groups || [];
    if (statGroupsCount) statGroupsCount.textContent = data.count || 0;
    const tabBadgeGroups = document.getElementById('tab-badge-groups');
    if (tabBadgeGroups) tabBadgeGroups.textContent = data.count || 0;
    renderGroupsTable(appState.groups);
    populateBroadcastSelect();
  } catch (err) {
    console.error('Erro ao carregar grupos:', err);
  }
}

function populateBroadcastSelect() {
  const select = document.getElementById('broadcast-target-select');
  if (!select) return;
  const currentVal = select.value;

  const rules = (appState.mappings?.rules || []).filter(r => r.targetGroupId);
  const groupMap = new Map();

  for (const r of rules) {
    groupMap.set(r.targetGroupId, `${r.targetGroupName || r.targetGroupId} (${r.client || 'Regra'})`);
  }
  for (const g of (appState.groups || [])) {
    if (!groupMap.has(g.id)) {
      groupMap.set(g.id, g.subject);
    }
  }

  const optionsHtml = Array.from(groupMap.entries())
    .sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'))
    .map(([id, label]) => `<option value="${escapeHtml(id)}">👥 ${escapeHtml(label)}</option>`)
    .join('');

  select.innerHTML = `
    <option value="">Selecione um destino...</option>
    <option value="ALL_ACTIVE_RULES">📢 Todos os Grupos das Regras Ativas (${rules.filter(r => r.active !== false).length})</option>
    ${optionsHtml}
  `;

  if (currentVal && [...select.options].some(o => o.value === currentVal)) {
    select.value = currentVal;
  }
}

document.getElementById('form-quick-broadcast')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const targetVal = document.getElementById('broadcast-target-select')?.value;
  const messageInput = document.getElementById('broadcast-message-input');
  const message = messageInput?.value.trim();
  const btn = document.getElementById('btn-send-broadcast');

  if (!targetVal || !message) {
    showToast('Selecione o grupo e digite a mensagem.', 'error');
    return;
  }

  let groupIds = [];
  if (targetVal === 'ALL_ACTIVE_RULES') {
    const activeRules = (appState.mappings?.rules || []).filter(r => r.active !== false && r.targetGroupId);
    groupIds = [...new Set(activeRules.map(r => r.targetGroupId))];
    if (groupIds.length === 0) {
      showToast('Nenhuma regra ativa com grupo configurado.', 'error');
      return;
    }
    if (!confirm(`Confirmar envio deste comunicado para ${groupIds.length} grupo(s) ativo(s)?`)) return;
  } else {
    groupIds = [targetVal];
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Enviando...';
  }

  try {
    const res = await fetch('/api/whatsapp/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds, message })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || 'Comunicado enviado!', 'success');
      if (messageInput) messageInput.value = '';
    } else {
      showToast(data.error || 'Falha ao enviar comunicado.', 'error');
    }
  } catch (err) {
    showToast('Erro de comunicação com o servidor.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📤 Enviar Comunicado';
    }
  }
});

function renderGroupsTable(groups) {
  if (!groups || groups.length === 0) {
    groupsTableBody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
          ${appState.waStatus === 'CONNECTED' ? 'Nenhum grupo encontrado nesta conta.' : 'Conecte o WhatsApp na primeira aba para listar os grupos.'}
        </td>
      </tr>
    `;
    return;
  }

  groupsTableBody.innerHTML = groups.map(g => `
    <tr>
      <td><strong>${escapeHtml(g.subject)}</strong></td>
      <td>
        <code style="color: var(--accent-blue); font-size: 0.82rem;">${g.id}</code>
      </td>
      <td><span class="badge badge-info">${g.participantsCount} membros</span></td>
      <td>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${g.id}', 'ID do grupo copiado!')">
            📋 Copiar ID
          </button>
          <button class="btn btn-primary btn-sm" onclick="prefillNewRule('${escapeHtml(g.id)}', '${escapeHtml(g.subject)}')">
            ➕ Criar Regra
          </button>
          <button class="btn btn-secondary btn-sm" onclick="setAsDefaultGroup('${escapeHtml(g.id)}', '${escapeHtml(g.subject)}')">
            ⭐ Tornar Padrão
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

document.getElementById('search-groups')?.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  const filtered = appState.groups.filter(g => g.subject.toLowerCase().includes(query) || g.id.toLowerCase().includes(query));
  renderGroupsTable(filtered);
});

document.getElementById('btn-refresh-groups')?.addEventListener('click', () => loadGroups(true));

// =========================================================================
// 3. MAPEAMENTOS DE REGRAS (COM EDIÇÃO RÁPIDA E BOTÃO ATIVAR/PAUSAR)
// =========================================================================
async function loadMappings() {
  try {
    const res = await fetch('/api/mappings');
    const data = await res.json();
    appState.mappings = data;
    if (data.webhookBaseUrl) {
      appState.webhookBaseUrl = data.webhookBaseUrl;
    }
    const rules = appState.mappings.rules || [];
    const tabBadgeRules = document.getElementById('tab-badge-rules');
    if (tabBadgeRules) tabBadgeRules.textContent = rules.length;
    renderRulesTable(rules);
    populateBroadcastSelect();
  } catch (err) {
    console.error('Erro ao carregar regras:', err);
  }
}

function slugifyClient(text) {
  if (!text) return '';
  return text.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function updateRuleUrlPreview() {
  const client = document.getElementById('rule-client')?.value.trim() || '';
  const network = document.getElementById('rule-network')?.value.trim() || '';
  const preview = document.getElementById('rule-url-preview');
  if (!preview) return;

  const base = appState.webhookBaseUrl || 'https://vuvchcevhezkxhmlxgrz.supabase.co/functions/v1/umovme-webhook';
  if (client && network) {
    preview.textContent = `${base}/${slugifyClient(client)}/${slugifyClient(network)}`;
  } else if (client) {
    preview.textContent = `${base}/${slugifyClient(client)}`;
  } else {
    preview.textContent = `${base}/[cliente]/[rede]`;
  }
}

document.getElementById('rule-client')?.addEventListener('input', updateRuleUrlPreview);
document.getElementById('rule-network')?.addEventListener('input', updateRuleUrlPreview);

function renderRulesTable(rules) {
  if (!rules || rules.length === 0) {
    rulesTableBody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
          Nenhuma rota cadastrada. Clique em "Nova Combinação Cliente x Rede" acima para criar seus webhooks.
        </td>
      </tr>
    `;
    return;
  }

  const base = appState.webhookBaseUrl || 'https://vuvchcevhezkxhmlxgrz.supabase.co/functions/v1/umovme-webhook';

  rulesTableBody.innerHTML = rules.map(r => {
    const clientName = r.client || r.matchValue || 'Geral';
    const networkName = r.network || (r.matchType === 'matrix' ? 'Todas as Redes' : (r.network || 'Todas as Redes (Geral)'));
    const slug = r.routeSlug || (r.client ? `${slugifyClient(r.client)}${r.network ? '/' + slugifyClient(r.network) : ''}` : '');
    const webhookUrl = slug ? `${base}/${slug}` : base;
    const isActive = r.active !== false;

    return `
      <tr style="${!isActive ? 'opacity: 0.65;' : ''}">
        <td>
          <strong style="color: var(--accent-brand); font-size: 0.95rem;">🏷️ ${escapeHtml(clientName)}</strong>
        </td>
        <td>
          <span class="badge ${r.network ? 'badge-info' : 'badge-brand'}">
            🏪 ${escapeHtml(networkName)}
          </span>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <code style="color: var(--accent-blue); font-size: 0.78rem; background: var(--bg-card-inner); padding: 0.28rem 0.55rem; border-radius: 6px; word-break: break-all; border: 1px solid var(--border-color);">
              ${webhookUrl}
            </code>
            <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${webhookUrl}', 'URL do Webhook Supabase [${escapeHtml(clientName)} - ${escapeHtml(networkName)}] copiada com sucesso!')" title="Copiar URL para colocar na uMov.me">
              📋 Copiar
            </button>
          </div>
        </td>
        <td>
          <div><strong>${escapeHtml(r.targetGroupName || 'Grupo')}</strong></div>
          <div style="font-size: 0.75rem; color: var(--text-dim);">${r.targetGroupId || '<span style="color:var(--accent-red)">JID pendente</span>'}</div>
        </td>
        <td>
          <button type="button" class="badge ${isActive ? 'badge-success' : 'badge-warning'}" style="cursor: pointer;" onclick="toggleRuleActive('${escapeHtml(r.id)}', ${!isActive})" title="Clique para Ativar ou Pausar esta regra">
            ${isActive ? '🟢 Ativa' : '⏸️ Pausada'}
          </button>
        </td>
        <td>
          <div style="display: flex; gap: 0.4rem; flex-wrap: wrap;">
            <button class="btn btn-secondary btn-sm" onclick="openEditRule('${escapeHtml(r.id)}')" title="Editar Cliente, Rede ou Grupo">
              ✏️ Editar
            </button>
            <button class="btn btn-secondary btn-sm" onclick="testMappedGroup('${escapeHtml(r.targetGroupId)}', '${escapeHtml(r.targetGroupName || 'Grupo')}', '${escapeHtml(clientName)}', this)" title="Enviar mensagem de teste para este grupo">
              🔔 Testar
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteRule('${escapeHtml(r.id)}')" title="Excluir regra">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

window.openEditRule = function(ruleId) {
  const rule = (appState.mappings?.rules || []).find(r => r.id === ruleId);
  if (!rule) return;
  const formCard = document.getElementById('form-new-rule-card');
  const heading = document.getElementById('form-rule-heading');
  const saveBtn = document.getElementById('btn-save-rule');

  document.getElementById('rule-edit-id').value = rule.id;
  document.getElementById('rule-client').value = rule.client || '';
  document.getElementById('rule-network').value = rule.network || '';
  document.getElementById('rule-group-id').value = rule.targetGroupId || '';
  document.getElementById('rule-group-name').value = rule.targetGroupName || '';

  if (heading) heading.textContent = `✏️ Editando Regra: ${rule.client || 'Cliente'} ${rule.network ? '➔ ' + rule.network : ''}`;
  if (saveBtn) saveBtn.textContent = '💾 Salvar Alterações';
  if (formCard) {
    formCard.style.display = 'block';
    formCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  updateRuleUrlPreview();
};

window.toggleRuleActive = async function(ruleId, newActive) {
  try {
    const res = await fetch(`/api/mappings/${encodeURIComponent(ruleId)}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: newActive })
    });
    if (res.ok) {
      showToast(newActive ? '🟢 Regra ativada com sucesso!' : '⏸️ Regra pausada temporariamente.', 'info');
      loadMappings();
    } else {
      showToast('Erro ao alterar status da regra.', 'error');
    }
  } catch (_) {
    showToast('Erro de comunicação com o servidor.', 'error');
  }
};

window.testMappedGroup = async function(groupId, groupName, clientName, btnEl) {
  if (!groupId) {
    showToast('Esta regra não possui um JID de grupo válido.', 'error');
    return;
  }
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '⏳...';
  }
  try {
    const res = await fetch('/api/whatsapp/test-group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, groupName, clientName })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || `Teste enviado ao grupo ${groupName}!`, 'success');
    } else {
      showToast(data.error || 'Erro ao enviar teste para o grupo.', 'error');
    }
  } catch (err) {
    showToast('Erro de comunicação com o servidor.', 'error');
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = '🔔 Testar';
    }
  }
};

const formCard = document.getElementById('form-new-rule-card');
function resetRuleFormState() {
  document.getElementById('form-new-rule')?.reset();
  const editInput = document.getElementById('rule-edit-id');
  if (editInput) editInput.value = '';
  const heading = document.getElementById('form-rule-heading');
  if (heading) heading.textContent = 'Nova Combinação: Cliente ➔ Rede ➔ Grupo (URL Supabase)';
  const saveBtn = document.getElementById('btn-save-rule');
  if (saveBtn) saveBtn.textContent = '💾 Salvar e Gerar Webhook';
  updateRuleUrlPreview();
}

document.getElementById('btn-toggle-add-rule')?.addEventListener('click', () => {
  resetRuleFormState();
  formCard.style.display = formCard.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('btn-cancel-rule')?.addEventListener('click', () => {
  resetRuleFormState();
  formCard.style.display = 'none';
});

function showWebhookGeneratedModal({ client, network, groupName, url }) {
  const modal = document.getElementById('modal-webhook-created');
  if (!modal) {
    showToast(`Webhook salvo no Supabase: ${url}`, 'success');
    return;
  }

  document.getElementById('modal-client-label').textContent = client;
  document.getElementById('modal-network-label').textContent = network;
  document.getElementById('modal-group-label').textContent = groupName;
  const codeEl = document.getElementById('modal-generated-url');
  codeEl.textContent = url;

  const copyBtn = document.getElementById('btn-modal-copy');
  copyBtn.textContent = '📋 Copiar URL do Webhook';
  copyBtn.onclick = () => {
    copyToClipboard(url, 'URL copiada! Cole na configuração de callback da uMov.me.');
    copyBtn.textContent = '✅ URL Copiada!';
    setTimeout(() => { copyBtn.textContent = '📋 Copiar URL do Webhook'; }, 3000);
  };

  const closeBtn = document.getElementById('btn-modal-close');
  closeBtn.onclick = () => { modal.style.display = 'none'; };

  modal.style.display = 'flex';
}

document.getElementById('modal-webhook-created')?.addEventListener('click', (e) => {
  if (e.target.id === 'modal-webhook-created') {
    e.target.style.display = 'none';
  }
});

document.getElementById('form-new-rule')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const editId = document.getElementById('rule-edit-id')?.value.trim() || '';
  const client = document.getElementById('rule-client').value.trim();
  const network = document.getElementById('rule-network').value.trim();
  const targetGroupId = document.getElementById('rule-group-id').value.trim();
  const targetGroupName = document.getElementById('rule-group-name').value.trim();

  const ruleData = {
    client,
    network,
    name: `${client} ${network ? '- Rede ' + network : '- Geral'}`,
    targetGroupId,
    targetGroupName: targetGroupName || `${client} [${network || 'Geral'}]`,
    active: true
  };

  try {
    const endpoint = editId ? `/api/mappings/${encodeURIComponent(editId)}` : '/api/mappings';
    const method = editId ? 'PUT' : 'POST';

    const res = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ruleData)
    });
    const data = await res.json();
    if (res.ok) {
      formCard.style.display = 'none';
      resetRuleFormState();
      loadMappings();

      const base = data.webhookBaseUrl || appState.webhookBaseUrl || 'https://vuvchcevhezkxhmlxgrz.supabase.co/functions/v1/umovme-webhook';
      const slug = ruleData.client ? `${slugifyClient(ruleData.client)}${ruleData.network ? '/' + slugifyClient(ruleData.network) : ''}` : '';
      const generatedUrl = data.webhookUrl || (slug ? `${base}/${slug}` : base);

      if (!editId) {
        showWebhookGeneratedModal({
          client: ruleData.client,
          network: ruleData.network || 'Todas as Redes (Geral)',
          groupName: ruleData.targetGroupName,
          url: generatedUrl
        });
      }
      showToast(editId ? 'Regra atualizada com sucesso no Supabase!' : 'Nova combinação criada com sucesso no Supabase!', 'success');
    } else {
      showToast(data.error || 'Erro ao salvar regra.', 'error');
    }
  } catch (err) {
    showToast('Erro ao conectar ao servidor.', 'error');
  }
});

async function deleteRule(id) {
  if (!confirm('Deseja excluir esta rota de webhook?')) return;
  try {
    await fetch(`/api/mappings/${id}`, { method: 'DELETE' });
    showToast('Rota removida.', 'info');
    loadMappings();
  } catch (err) {
    showToast('Erro ao excluir regra.', 'error');
  }
}

function prefillNewRule(groupId, groupName) {
  document.querySelector('[data-tab=tab-mappings]').click();
  resetRuleFormState();
  formCard.style.display = 'block';
  document.getElementById('rule-group-id').value = groupId;
  document.getElementById('rule-group-name').value = groupName;
  document.getElementById('rule-client').focus();
  updateRuleUrlPreview();
}

async function setAsDefaultGroup(groupId, groupName) {
  try {
    const settings = appState.settings || {};
    settings.defaultGroup = {
      enabled: true,
      groupId: groupId,
      groupName: groupName
    };
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    showToast(`"${groupName}" definido como grupo padrão de fallback!`, 'success');
    loadSettings();
  } catch (err) {
    showToast('Erro ao definir grupo padrão.', 'error');
  }
}

// =========================================================================
// 4. KPIS EXECUTIVOS, RANKING DE PRODUTIVIDADE & FEED DE ATIVIDADES
// =========================================================================
function getBrazilDayKey(dateObj) {
  try {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(dateObj);
    const m = {};
    for (const p of parts) m[p.type] = p.value;
    return {
      key: `${m.year}-${m.month}-${m.day}`,
      label: `${m.day}/${m.month}/${m.year}`
    };
  } catch (_) {
    const iso = dateObj.toISOString().slice(0, 10);
    return { key: iso, label: iso.split('-').reverse().join('/') };
  }
}

function deriveItemDateKey(item) {
  if (item.dateKey) return item.dateKey;
  if (item.date && /^\d{2}\/\d{2}\/\d{4}/.test(item.date)) {
    const [d, m, y] = item.date.slice(0, 10).split('/');
    return `${y}-${m}-${d}`;
  }
  if (item.timestamp) {
    return getBrazilDayKey(new Date(item.timestamp)).key;
  }
  return '';
}

function updateExecutiveKpisAndRanking(items) {
  const all = Array.isArray(items) ? items : [];
  const todayKey = getBrazilDayKey(new Date()).key;

  const todayItems = all.filter(i => deriveItemDateKey(i) === todayKey);
  const sentToday = todayItems.filter(i => i.status === 'COMPLETED').length;

  const storesTodaySet = new Set();
  const storesWeekSet = new Set();
  let completedTotal = 0;
  let failedTotal = 0;
  let totalPhotosWeek = 0;
  let totalRupturas = 0;

  const promoterMap = new Map();
  const clientMap = new Map();
  const storeMap = new Map();

  for (const item of todayItems) {
    const pdv = (item.pdvName || '').trim();
    if (pdv && pdv !== 'Loja em Campo') storesTodaySet.add(pdv);
  }

  for (const item of all) {
    const pdv = (item.pdvName || 'Loja em Campo').trim();
    const prom = (item.promoterName || 'Promotor de Campo').trim();
    const cli = (item.clientName || 'Geral').trim();

    if (pdv && pdv !== 'Loja em Campo') storesWeekSet.add(pdv);
    if (item.status === 'COMPLETED') completedTotal++;
    if (item.status === 'FAILED' || item.status === 'IGNORED_NO_GROUP') failedTotal++;
    totalPhotosWeek += Number(item.photoCount || 0);
    if (item.hasRuptura) totalRupturas++;

    if (prom) promoterMap.set(prom, (promoterMap.get(prom) || 0) + 1);
    if (cli) clientMap.set(cli, (clientMap.get(cli) || 0) + 1);
    if (pdv) storeMap.set(pdv, (storeMap.get(pdv) || 0) + 1);
  }

  const finishedDenominator = completedTotal + failedTotal;
  const successRate = finishedDenominator > 0 ? Math.round((completedTotal / finishedDenominator) * 100) : 100;

  // Atualizar os 5 Cards de KPI do Topo
  const elSentToday = document.getElementById('stat-sent-today');
  const elActCount = document.getElementById('stat-activities-count');
  const elStoresToday = document.getElementById('stat-stores-today');
  const elStoresWeek = document.getElementById('stat-stores-week');
  const elSuccessRate = document.getElementById('stat-success-rate');
  const elSuccessBar = document.getElementById('stat-success-bar');
  const tabBadgeFeed = document.getElementById('tab-badge-feed');

  if (elSentToday) elSentToday.textContent = sentToday;
  if (elActCount) elActCount.textContent = all.length;
  if (tabBadgeFeed) tabBadgeFeed.textContent = all.length;
  if (elStoresToday) elStoresToday.textContent = storesTodaySet.size;
  if (elStoresWeek) elStoresWeek.textContent = storesWeekSet.size;
  if (elSuccessRate) {
    elSuccessRate.textContent = `${successRate}%`;
    elSuccessRate.style.color = successRate >= 90 ? 'var(--accent-wa)' : successRate >= 70 ? 'var(--accent-amber)' : 'var(--accent-red)';
  }
  if (elSuccessBar) {
    elSuccessBar.style.width = `${successRate}%`;
  }

  // Atualizar aba de Ranking & Produtividade (7d)
  const rkPhotos = document.getElementById('rank-kpi-photos');
  const rkPromoters = document.getElementById('rank-kpi-promoters');
  const rkClients = document.getElementById('rank-kpi-clients');
  const rkRupturas = document.getElementById('rank-kpi-rupturas');

  if (rkPhotos) rkPhotos.textContent = totalPhotosWeek;
  if (rkPromoters) rkPromoters.textContent = promoterMap.size;
  if (rkClients) rkClients.textContent = clientMap.size;
  if (rkRupturas) rkRupturas.textContent = totalRupturas;

  const renderBarList = (containerId, mapObj, badgeClass = 'badge-brand') => {
    const el = document.getElementById(containerId);
    if (!el) return;
    const sorted = Array.from(mapObj.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (sorted.length === 0) {
      el.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem;">Sem dados suficientes no período.</p>`;
      return;
    }
    const maxVal = sorted[0][1] || 1;
    el.innerHTML = sorted.map(([name, count], idx) => {
      const pct = Math.max(8, Math.round((count / maxVal) * 100));
      const medal = idx === 0 ? '🥇 ' : idx === 1 ? '🥈 ' : idx === 2 ? '🥉 ' : `${idx + 1}. `;
      return `
        <div class="ranking-row">
          <div class="ranking-row-header">
            <span style="color: var(--text-main);">${medal}${escapeHtml(name)}</span>
            <span class="badge ${badgeClass}">${count} exec.</span>
          </div>
          <div class="ranking-bar-bg">
            <div class="ranking-bar-fill" style="width: ${pct}%;"></div>
          </div>
        </div>
      `;
    }).join('');
  };

  renderBarList('ranking-promoters-list', promoterMap, 'badge-brand');
  renderBarList('ranking-clients-list', clientMap, 'badge-success');
  renderBarList('ranking-stores-list', storeMap, 'badge-info');
}

function populateFeedFilterOptions(items) {
  const daySelect = document.getElementById('feed-filter-day');
  const promoterSelect = document.getElementById('feed-filter-promoter');

  if (daySelect) {
    const currentDayVal = daySelect.value || 'ALL';
    const dayCounts = {};
    for (const item of items) {
      const k = deriveItemDateKey(item);
      if (k) dayCounts[k] = (dayCounts[k] || 0) + 1;
    }

    const last7Days = [];
    const seenKeys = new Set();
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const info = getBrazilDayKey(d);
      if (!seenKeys.has(info.key)) {
        seenKeys.add(info.key);
        let prefix = '';
        if (i === 0) prefix = 'Hoje - ';
        else if (i === 1) prefix = 'Ontem - ';
        last7Days.push({
          key: info.key,
          text: `${prefix}${info.label} (${dayCounts[info.key] || 0})`
        });
      }
    }

    daySelect.innerHTML = `<option value="ALL">📅 Todos os últimos 7 dias (${items.length})</option>` +
      last7Days.map(d => `<option value="${d.key}">${d.text}</option>`).join('');

    if ([...daySelect.options].some(o => o.value === currentDayVal)) {
      daySelect.value = currentDayVal;
    }
  }

  if (promoterSelect) {
    const currentPromoterVal = promoterSelect.value || 'ALL';
    const selectedDay = daySelect ? daySelect.value : 'ALL';
    const baseForPromoters = selectedDay === 'ALL'
      ? items
      : items.filter(i => deriveItemDateKey(i) === selectedDay);

    const promoterMap = new Map();
    for (const item of baseForPromoters) {
      const name = (item.promoterName || 'Promotor de Campo').trim();
      if (!name) continue;
      promoterMap.set(name, (promoterMap.get(name) || 0) + 1);
    }

    const sortedPromoters = Array.from(promoterMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));

    promoterSelect.innerHTML = `<option value="ALL">👤 Todos os Promotores (${sortedPromoters.length})</option>` +
      sortedPromoters.map(([name, count]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)} (${count})</option>`).join('');

    if ([...promoterSelect.options].some(o => o.value === currentPromoterVal)) {
      promoterSelect.value = currentPromoterVal;
    }
  }
}

function applyFeedFiltersAndRender() {
  const allItems = appState.history || [];
  const dayVal = document.getElementById('feed-filter-day')?.value || 'ALL';
  const promoterVal = document.getElementById('feed-filter-promoter')?.value || 'ALL';
  const statusVal = document.getElementById('feed-filter-status')?.value || 'ALL';
  const searchVal = (document.getElementById('feed-filter-search')?.value || '').trim().toLowerCase();

  const baseFiltered = allItems.filter(item => {
    if (dayVal !== 'ALL' && deriveItemDateKey(item) !== dayVal) return false;
    if (promoterVal !== 'ALL' && (item.promoterName || '').trim() !== promoterVal) return false;
    if (searchVal) {
      const hay = `${item.promoterName || ''} ${item.pdvName || ''} ${item.clientName || ''} ${item.networkName || ''} ${item.activityId || ''} ${(item.targetGroups || []).join(' ')}`.toLowerCase();
      if (!hay.includes(searchVal)) return false;
    }
    return true;
  });

  let sentCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let rupturaCount = 0;

  for (const item of baseFiltered) {
    if (item.status === 'COMPLETED') sentCount++;
    else if (item.status === 'QUEUED' || item.status === 'PROCESSING') pendingCount++;
    else failedCount++;
    if (item.hasRuptura) rupturaCount++;
  }

  const finalItems = baseFiltered.filter(item => {
    if (statusVal === 'SENT') return item.status === 'COMPLETED';
    if (statusVal === 'PENDING') return item.status === 'QUEUED' || item.status === 'PROCESSING';
    if (statusVal === 'FAILED') return item.status === 'FAILED' || item.status === 'IGNORED_NO_GROUP';
    if (statusVal === 'RUPTURA') return Boolean(item.hasRuptura);
    return true;
  });

  const elTotal = document.getElementById('count-feed-total');
  const elSent = document.getElementById('count-feed-sent');
  const elPending = document.getElementById('count-feed-pending');
  const elFailed = document.getElementById('count-feed-failed');
  const elRuptura = document.getElementById('count-feed-ruptura');

  if (elTotal) elTotal.textContent = finalItems.length;
  if (elSent) elSent.textContent = sentCount;
  if (elPending) elPending.textContent = pendingCount;
  if (elFailed) elFailed.textContent = failedCount;
  if (elRuptura) elRuptura.textContent = rupturaCount;

  appState.filteredHistory = finalItems;
  renderActivityFeed(finalItems);
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history?limit=1000');
    appState.history = await res.json();
    updateExecutiveKpisAndRanking(appState.history);
    populateFeedFilterOptions(appState.history);
    applyFeedFiltersAndRender();
  } catch (err) {
    console.error('Erro ao carregar histórico:', err);
  }
}

function formatPhotoShortTag(label, idx, total) {
  const lower = String(label || '').toLowerCase();
  if (lower.includes('antes')) return 'ANTES';
  if (lower.includes('extra')) return 'P. EXTRA';
  if (lower.includes('backlight')) return 'BACKLIGHT';
  if (lower.includes('mix')) return 'MIX';
  if (lower.includes('depois')) return 'DEPOIS';
  if (idx === 0) return 'ANTES';
  return `FOTO ${idx + 1}`;
}

function renderActivityFeed(items) {
  if (!items || items.length === 0) {
    activityFeedList.innerHTML = `
      <p style="text-align: center; color: var(--text-muted); padding: 2rem;">
        Nenhuma atividade encontrada para os filtros selecionados.
      </p>
    `;
    return;
  }

  activityFeedList.innerHTML = items.map((item, itemIdx) => {
    let statusBadge = '<span class="badge badge-warning">⏳ Pendente / Na Fila</span>';
    if (item.status === 'COMPLETED') statusBadge = '<span class="badge badge-success">✅ Enviado no WhatsApp</span>';
    if (item.status === 'PROCESSING') statusBadge = '<span class="badge badge-info">📤 Enviando Fotos Agora...</span>';
    if (item.status === 'FAILED') statusBadge = '<span class="badge badge-danger">❌ Falha no Envio</span>';
    if (item.status === 'IGNORED_NO_GROUP') statusBadge = '<span class="badge badge-warning">⚠️ Sem Grupo Mapeado</span>';

    const rupturaBadge = item.hasRuptura
      ? `<span class="badge badge-ruptura" title="Ruptura reportada: ${escapeHtml(item.rupturaText || 'Sim')}">🚨 ALERTA DE RUPTURA: ${escapeHtml(item.rupturaText || 'Sim')}</span>`
      : '';

    const targetId = item.id || item.activityId;
    let retryBtnHtml = '';
    if (item.status === 'FAILED' || item.status === 'IGNORED_NO_GROUP') {
      retryBtnHtml = `
        <button type="button" class="btn btn-primary btn-sm" onclick="retrySingleActivity('${escapeHtml(String(targetId))}', this)">
          🔄 Reenviar Agora
        </button>
      `;
    } else if (item.status === 'QUEUED') {
      retryBtnHtml = `
        <button type="button" class="btn btn-secondary btn-sm" onclick="retrySingleActivity('${escapeHtml(String(targetId))}', this)" title="Forçar disparo imediato">
          ⚡ Disparar
        </button>
      `;
    }

    const clientTag = item.clientName
      ? `<span class="badge badge-brand" style="margin-right: 0.4rem;">🏷️ ${escapeHtml(item.clientName)}</span>`
      : '';

    // Renderizar Galeria de Miniaturas das Fotos (se disponível)
    const photos = Array.isArray(item.photos) ? item.photos : [];
    let photosStripHtml = '';
    if (photos.length > 0) {
      const thumbs = photos.map((p, pIdx) => {
        const url = typeof p === 'object' ? p.url : p;
        const tag = formatPhotoShortTag(typeof p === 'object' ? p.label : '', pIdx, photos.length);
        return `
          <div class="activity-thumb-card" onclick="openPhotoLightbox(${itemIdx}, ${pIdx})" title="Clique para ampliar (${tag})">
            <img src="${escapeHtml(url)}" loading="lazy" alt="${escapeHtml(tag)}">
            <span class="activity-thumb-tag">${escapeHtml(tag)}</span>
          </div>
        `;
      }).join('');
      photosStripHtml = `<div class="activity-photos-strip">${thumbs}</div>`;
    }

    return `
      <div class="activity-item ${item.hasRuptura ? 'has-ruptura' : ''}">
        <div class="activity-avatar">${item.status === 'COMPLETED' ? '✅' : item.status === 'PROCESSING' ? '📤' : item.status === 'FAILED' ? '❌' : '📸'}</div>
        <div class="activity-details">
          <div class="activity-header-line" style="flex-wrap: wrap; gap: 0.5rem;">
            <span class="activity-title-text">${clientTag}${escapeHtml(item.pdvName || 'PDV')} &bull; ${escapeHtml(item.activityName || 'Atividade')}</span>
            <div style="display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap;">
              ${rupturaBadge}
              ${statusBadge}
              ${retryBtnHtml}
            </div>
          </div>
          <div class="activity-meta">
            <span>👤 Promotor: <strong>${escapeHtml(item.promoterName || 'N/A')}</strong></span>
            <span>📅 ${escapeHtml(item.date || '')}</span>
            <span>🖼️ <strong>${item.photoCount || 0}</strong> fotos ${photos.length > 0 ? `<a href="javascript:void(0)" onclick="openPhotoLightbox(${itemIdx}, 0)" style="color: var(--accent-brand); font-weight: 700; margin-left: 0.25rem;">(Ampliar 🔍)</a>` : ''}</span>
            <span>🎯 Grupos: <em>${escapeHtml((item.targetGroups || []).join(', '))}</em></span>
          </div>
          ${photosStripHtml}
          ${item.error ? `<div style="color: var(--accent-red); font-size: 0.8rem; margin-top: 0.45rem;">⚠️ Erro: ${escapeHtml(item.error)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// =========================================================================
// 4.5. LIGHTBOX DE FOTOS EM TELA CHEIA
// =========================================================================
window.openPhotoLightbox = function(itemIndex, photoIndex = 0) {
  const list = appState.filteredHistory || appState.history || [];
  const item = list[itemIndex];
  if (!item || !Array.isArray(item.photos) || item.photos.length === 0) return;

  appState.lightbox = {
    photos: item.photos,
    currentIndex: photoIndex,
    title: `${item.clientName ? item.clientName + ' • ' : ''}${item.pdvName || 'Loja'}`,
    subtitle: `Promotor: ${item.promoterName || '-'} • Data: ${item.date || '-'}`
  };

  renderLightboxSlide();
  const modal = document.getElementById('modal-photo-lightbox');
  if (modal) modal.style.display = 'flex';
};

function renderLightboxSlide() {
  const lb = appState.lightbox;
  if (!lb.photos || lb.photos.length === 0) return;

  const total = lb.photos.length;
  const idx = ((lb.currentIndex % total) + total) % total;
  lb.currentIndex = idx;

  const photoObj = lb.photos[idx];
  const url = typeof photoObj === 'object' ? photoObj.url : photoObj;
  const label = formatPhotoShortTag(typeof photoObj === 'object' ? photoObj.label : '', idx, total);

  document.getElementById('lightbox-title').textContent = lb.title;
  document.getElementById('lightbox-subtitle').textContent = lb.subtitle;
  document.getElementById('lightbox-counter').textContent = `${idx + 1} / ${total}`;
  document.getElementById('lightbox-image').src = url;
  document.getElementById('lightbox-open-original').href = url;
  document.getElementById('lightbox-caption').textContent = `📸 FOTO ${idx + 1}: ${label}`;
}

document.getElementById('btn-lightbox-prev')?.addEventListener('click', () => {
  appState.lightbox.currentIndex--;
  renderLightboxSlide();
});

document.getElementById('btn-lightbox-next')?.addEventListener('click', () => {
  appState.lightbox.currentIndex++;
  renderLightboxSlide();
});

document.getElementById('btn-close-lightbox')?.addEventListener('click', () => {
  const modal = document.getElementById('modal-photo-lightbox');
  if (modal) modal.style.display = 'none';
});

document.getElementById('modal-photo-lightbox')?.addEventListener('click', (e) => {
  if (e.target.id === 'modal-photo-lightbox') {
    e.target.style.display = 'none';
  }
});

document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('modal-photo-lightbox');
  if (!modal || modal.style.display === 'none') return;
  if (e.key === 'ArrowLeft') {
    appState.lightbox.currentIndex--;
    renderLightboxSlide();
  } else if (e.key === 'ArrowRight') {
    appState.lightbox.currentIndex++;
    renderLightboxSlide();
  } else if (e.key === 'Escape') {
    modal.style.display = 'none';
  }
});

window.retrySingleActivity = async function(id, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '⏳ Reenviando...';
  }
  try {
    const res = await fetch(`/api/history/retry/${encodeURIComponent(id)}`, { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Atividade (${data.pdvName || id}) recolocada na fila de envio!`, 'success');
      setTimeout(loadHistory, 800);
      setTimeout(checkQueue, 800);
    } else {
      showToast(data.error || 'Não foi possível reenviar esta atividade.', 'error');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = '🔄 Reenviar Agora';
      }
    }
  } catch (err) {
    showToast('Erro de comunicação com o servidor.', 'error');
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = '🔄 Reenviar Agora';
    }
  }
};

document.getElementById('btn-retry-all-failed')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '⏳ Reenfileirando...';
  try {
    const res = await fetch('/api/history/retry-all-failed', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || 'Atividades reenfileiradas!', data.count > 0 ? 'success' : 'info');
      setTimeout(loadHistory, 800);
      setTimeout(checkQueue, 800);
    } else {
      showToast(data.error || 'Erro ao reenviar atividades com falha.', 'error');
    }
  } catch (err) {
    showToast('Erro ao conectar ao servidor.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

document.getElementById('btn-refresh-feed')?.addEventListener('click', loadHistory);
document.getElementById('feed-filter-day')?.addEventListener('change', () => {
  populateFeedFilterOptions(appState.history || []);
  applyFeedFiltersAndRender();
});
document.getElementById('feed-filter-promoter')?.addEventListener('change', applyFeedFiltersAndRender);
document.getElementById('feed-filter-status')?.addEventListener('change', applyFeedFiltersAndRender);
document.getElementById('feed-filter-search')?.addEventListener('input', applyFeedFiltersAndRender);

document.getElementById('btn-clear-feed-filters')?.addEventListener('click', () => {
  const dayEl = document.getElementById('feed-filter-day');
  const promEl = document.getElementById('feed-filter-promoter');
  const statEl = document.getElementById('feed-filter-status');
  const searchEl = document.getElementById('feed-filter-search');
  if (dayEl) dayEl.value = 'ALL';
  if (promEl) promEl.value = 'ALL';
  if (statEl) statEl.value = 'ALL';
  if (searchEl) searchEl.value = '';
  populateFeedFilterOptions(appState.history || []);
  applyFeedFiltersAndRender();
});

// Clique rápido nos contadores do topo
document.getElementById('pill-filter-all')?.addEventListener('click', () => {
  const statEl = document.getElementById('feed-filter-status');
  if (statEl) { statEl.value = 'ALL'; applyFeedFiltersAndRender(); }
});
document.getElementById('pill-filter-sent')?.addEventListener('click', () => {
  const statEl = document.getElementById('feed-filter-status');
  if (statEl) { statEl.value = 'SENT'; applyFeedFiltersAndRender(); }
});
document.getElementById('pill-filter-pending')?.addEventListener('click', () => {
  const statEl = document.getElementById('feed-filter-status');
  if (statEl) { statEl.value = 'PENDING'; applyFeedFiltersAndRender(); }
});
document.getElementById('pill-filter-failed')?.addEventListener('click', () => {
  const statEl = document.getElementById('feed-filter-status');
  if (statEl) { statEl.value = 'FAILED'; applyFeedFiltersAndRender(); }
});
document.getElementById('pill-filter-ruptura')?.addEventListener('click', () => {
  const statEl = document.getElementById('feed-filter-status');
  if (statEl) { statEl.value = 'RUPTURA'; applyFeedFiltersAndRender(); }
});

// Exportar Histórico Filtrado para Planilha Excel (CSV UTF-8 com BOM)
document.getElementById('btn-export-feed-csv')?.addEventListener('click', () => {
  const items = appState.filteredHistory || appState.history || [];
  if (items.length === 0) {
    showToast('Nenhuma atividade na lista atual para exportar.', 'error');
    return;
  }

  const headers = ['Data/Hora', 'Cliente/Marca', 'Rede', 'Loja/PDV', 'Promotor', 'Tipo de Atividade', 'Qtd Fotos', 'Ruptura', 'Grupos WhatsApp', 'Status', 'Erro'];
  const statusLabels = {
    COMPLETED: 'Enviado',
    QUEUED: 'Na Fila',
    PROCESSING: 'Enviando',
    FAILED: 'Falha',
    IGNORED_NO_GROUP: 'Sem Grupo'
  };

  const escapeCsv = (val) => {
    const str = String(val ?? '').replace(/\r?\n/g, ' ').trim();
    return `"${str.replace(/"/g, '""')}"`;
  };

  const rows = items.map(i => [
    escapeCsv(i.date || ''),
    escapeCsv(i.clientName || ''),
    escapeCsv(i.networkName || ''),
    escapeCsv(i.pdvName || ''),
    escapeCsv(i.promoterName || ''),
    escapeCsv(i.activityName || ''),
    escapeCsv(i.photoCount || 0),
    escapeCsv(i.hasRuptura ? (i.rupturaText || 'Sim') : 'Não'),
    escapeCsv((i.targetGroups || []).join(' | ')),
    escapeCsv(statusLabels[i.status] || i.status || ''),
    escapeCsv(i.error || '')
  ].join(';'));

  const csvContent = '\uFEFF' + [headers.join(';'), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dayVal = document.getElementById('feed-filter-day')?.value || '7dias';
  a.href = url;
  a.download = `relatorio-objetiva-trade-${dayVal.toLowerCase()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Planilha exportada com ${items.length} registro(s)!`, 'success');
});

// =========================================================================
// 5. CONFIGURAÇÕES DA FILA ANTI-BAN & CONTROLE PAUSAR/RETOMAR FILA
// =========================================================================
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    appState.settings = await res.json();
    const s = appState.settings;

    if (s.queue) {
      const minEl = document.getElementById('setting-min-delay');
      const maxEl = document.getElementById('setting-max-delay');
      if (minEl) minEl.value = s.queue.minDelaySeconds || 3;
      if (maxEl) maxEl.value = s.queue.maxDelaySeconds || 7;
    }

    if (s.defaultGroup) {
      const gidEl = document.getElementById('setting-default-group-id');
      const gnameEl = document.getElementById('setting-default-group-name');
      if (gidEl) gidEl.value = s.defaultGroup.groupId || '';
      if (gnameEl) gnameEl.value = s.defaultGroup.groupName || '';
    }
  } catch (err) {
    console.error('Erro ao carregar configurações:', err);
  }
}

document.getElementById('form-settings')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = appState.settings || {};

  const updated = {
    ...current,
    queue: {
      ...(current.queue || {}),
      minDelaySeconds: parseInt(document.getElementById('setting-min-delay')?.value) || 3,
      maxDelaySeconds: parseInt(document.getElementById('setting-max-delay')?.value) || 7
    },
    defaultGroup: {
      enabled: true,
      groupId: (document.getElementById('setting-default-group-id')?.value || '').trim(),
      groupName: (document.getElementById('setting-default-group-name')?.value || '').trim()
    }
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated)
    });
    if (res.ok) {
      showToast('Configurações salvas com sucesso!', 'success');
      loadSettings();
    } else {
      showToast('Erro ao salvar configurações.', 'error');
    }
  } catch (err) {
    showToast('Erro ao conectar ao servidor.', 'error');
  }
});

// Botão Pausar / Retomar Fila
document.getElementById('btn-toggle-queue-pause')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/queue/toggle-pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, data.isPaused ? 'info' : 'success');
      checkQueue();
    }
  } catch (_) {
    showToast('Erro ao alternar pausa da fila.', 'error');
  }
});

async function checkQueue() {
  try {
    const res = await fetch('/api/queue');
    const data = await res.json();
    appState.queue = data;

    if (statQueueCount) {
      statQueueCount.textContent = data.isPaused
        ? `⏸️ Pausada (${data.pendingCount})`
        : `${data.pendingCount} pendente(s)`;
      statQueueCount.style.color = data.isPaused
        ? 'var(--accent-red)'
        : data.isProcessing
          ? 'var(--accent-brand)'
          : 'var(--text-main)';
    }

    const pauseBtn = document.getElementById('btn-toggle-queue-pause');
    if (pauseBtn) {
      if (data.isPaused) {
        pauseBtn.className = 'btn btn-primary btn-sm';
        pauseBtn.innerHTML = '▶️ Retomar Fila';
      } else {
        pauseBtn.className = 'btn btn-secondary btn-sm';
        pauseBtn.innerHTML = '⏸️ Pausar Fila';
      }
    }

    const monitorEl = document.getElementById('live-dispatch-monitor');
    const badgeEl = document.getElementById('live-monitor-badge');
    if (!monitorEl) return;

    if (data.isPaused) {
      if (badgeEl) {
        badgeEl.className = 'badge badge-danger';
        badgeEl.textContent = '⏸️ Fila Pausada Manualmente';
      }
      monitorEl.innerHTML = `
        <div class="inner-panel" style="margin-bottom: 0; border-color: rgba(239, 68, 68, 0.4);">
          <strong style="color: var(--accent-red);">⏸️ Os disparos para os grupos estão pausados temporariamente.</strong>
          <p style="font-size: 0.84rem; color: var(--text-muted); margin-top: 0.3rem;">
            Novas atividades enviadas pela uMov.me continuam sendo guardadas com segurança (${data.pendingCount} aguardando). Clique em <strong>▶️ Retomar Fila</strong> acima para liberar o envio.
          </p>
        </div>
      `;
      return;
    }

    if (data.isProcessing && data.currentItem) {
      const c = data.currentItem;
      const total = c.photos || 0;
      const currentPhoto = c.currentPhoto || 0;
      const pct = total > 0 ? Math.min(100, Math.round((currentPhoto / total) * 100)) : 50;

      if (badgeEl) {
        badgeEl.className = 'badge badge-brand';
        badgeEl.textContent = '📤 Disparando Agora...';
      }

      monitorEl.innerHTML = `
        <div class="inner-panel" style="margin-bottom: 0; border-color: var(--border-glow);">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.6rem;">
            <div>
              <strong style="color: var(--text-main); font-size: 0.95rem;">🏪 ${escapeHtml(c.pdv || 'Loja em Campo')}</strong>
              ${c.client ? `<span class="badge badge-brand" style="margin-left: 0.5rem;">${escapeHtml(c.client)}</span>` : ''}
            </div>
            <span style="font-size: 0.82rem; color: var(--accent-wa); font-weight: 700;">
              ${currentPhoto > 0 ? `📸 Enviando foto ${currentPhoto} de ${total}` : '📝 Enviando card de resumo...'}
            </span>
          </div>
          <div style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.7rem;">
            👤 Promotor: <strong>${escapeHtml(c.promoter || '-')}</strong> &bull; 🎯 Grupo: <strong>${escapeHtml(c.groupName || '-')}</strong>
          </div>
          <div class="kpi-progress-bar" style="height: 8px;">
            <div class="kpi-progress-fill" style="width: ${pct}%;"></div>
          </div>
          ${data.pendingCount > 0 ? `<div style="font-size: 0.76rem; color: var(--text-dim); margin-top: 0.55rem;">⏳ +${data.pendingCount} atividade(s) aguardando na fila anti-ban</div>` : ''}
        </div>
      `;
    } else {
      if (badgeEl) {
        badgeEl.className = 'badge badge-info';
        badgeEl.textContent = data.pendingCount > 0 ? `⏳ ${data.pendingCount} na Fila` : '💤 Fila Livre';
      }
      monitorEl.innerHTML = `
        <p style="color: var(--text-muted); font-size: 0.9rem;">
          ✅ Fila livre no momento. Aguardando novas atividades finalizadas na uMov.me...
        </p>
      `;
    }
  } catch (_) {}
}

// Helpers
function copyToClipboard(text, successMsg = 'Copiado para a área de transferência!') {
  navigator.clipboard.writeText(text).then(() => {
    showToast(successMsg, 'success');
  }).catch(() => {
    showToast('Erro ao copiar para a área de transferência.', 'error');
  });
}

document.getElementById('btn-refresh-all')?.addEventListener('click', () => {
  checkWhatsAppStatus();
  loadGroups(true);
  loadMappings();
  loadHistory();
  checkQueue();
  showToast('Dados atualizados.', 'info');
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =========================================================================
// 7. AMBIENTE DE LOGIN E SENHA INTERATIVO (CONECTADO AO SUPABASE)
// =========================================================================
const authOverlay = document.getElementById('auth-overlay');
const authAlertBox = document.getElementById('auth-alert-box');
const formAuthLogin = document.getElementById('form-auth-login');
const formAuthRegister = document.getElementById('form-auth-register');
const btnModeLogin = document.getElementById('btn-auth-mode-login');
const btnModeRegister = document.getElementById('btn-auth-mode-register');

function showAuthAlert(msg, type = 'error') {
  if (!authAlertBox) return;
  authAlertBox.style.display = 'block';
  if (type === 'success') {
    authAlertBox.style.background = 'rgba(16, 185, 129, 0.15)';
    authAlertBox.style.border = '1px solid rgba(16, 185, 129, 0.45)';
    authAlertBox.style.color = '#34d399';
  } else {
    authAlertBox.style.background = 'rgba(239, 68, 68, 0.15)';
    authAlertBox.style.border = '1px solid rgba(239, 68, 68, 0.45)';
    authAlertBox.style.color = '#f87171';
  }
  authAlertBox.textContent = msg;
}

function hideAuthAlert() {
  if (authAlertBox) authAlertBox.style.display = 'none';
}

function showAuthOverlay() {
  if (authOverlay) {
    authOverlay.style.display = 'flex';
  }
}

function hideAuthOverlay(user) {
  if (authOverlay) authOverlay.style.display = 'none';
  if (user) {
    appState.currentUser = user;
    const badge = document.getElementById('user-logged-badge');
    const emailEl = document.getElementById('user-logged-email');
    if (badge && emailEl) {
      emailEl.textContent = user.name || user.username || user.email;
      badge.style.display = 'inline-flex';
    }
  }
}

btnModeLogin?.addEventListener('click', () => {
  hideAuthAlert();
  formAuthLogin.style.display = 'block';
  formAuthRegister.style.display = 'none';
});

btnModeRegister?.addEventListener('click', () => {
  hideAuthAlert();
  formAuthRegister.style.display = 'block';
  formAuthLogin.style.display = 'none';
});

function startDashboardAll() {
  checkWhatsAppStatus();
  loadSettings();
  loadMappings();
  loadGroups(false);
  loadHistory();
  checkQueue();
}

formAuthLogin?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthAlert();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('btn-submit-login');
  btn.disabled = true;
  btn.textContent = '⏳ Verificando acesso...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, email, password })
    });
    const data = await res.json();
    if (res.ok && data.token) {
      localStorage.setItem('trade_hub_token', data.token);
      hideAuthOverlay(data.user);
      showToast(`Bem-vindo(a), ${data.user.name || data.user.username || data.user.email}!`, 'success');
      startDashboardAll();
    } else {
      showAuthAlert(data.error || 'Usuário ou senha incorretos.');
    }
  } catch (err) {
    showAuthAlert('Erro de conexão com o servidor.');
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Entrar no Sistema';
  }
});

formAuthRegister?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthAlert();
  const name = document.getElementById('register-name').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const btn = document.getElementById('btn-submit-register');
  btn.disabled = true;
  btn.textContent = '⏳ Salvando usuário...';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username: email, email, password })
    });
    const data = await res.json();
    if (res.ok) {
      if (data.approved && data.token) {
        localStorage.setItem('trade_hub_token', data.token);
        hideAuthOverlay(data.user);
        showToast(data.message || 'Usuário criado com sucesso!', 'success');
        startDashboardAll();
      } else {
        showAuthAlert(data.message || 'Usuário cadastrado!', 'success');
        formAuthRegister.reset();
      }
    } else {
      showAuthAlert(data.error || 'Erro ao criar usuário.');
    }
  } catch (err) {
    showAuthAlert('Erro ao conectar ao servidor.');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Criar Usuário e Entrar';
  }
});

document.getElementById('btn-logout-system')?.addEventListener('click', () => {
  localStorage.removeItem('trade_hub_token');
  appState.currentUser = null;
  showAuthOverlay();
  showToast('Sessão encerrada.', 'info');
});

function updateSupabaseAuthBadges(data) {
  if (!data) return;

  const loginBadgeText = document.getElementById('auth-supabase-status-text');
  if (loginBadgeText) {
    if (data.supabaseConnected && data.usuariosTableExists) {
      loginBadgeText.textContent = 'Supabase Conectado • Tabela usuarios Ativa';
    } else if (data.supabaseConnected) {
      loginBadgeText.textContent = 'Supabase Conectado • Pronto para Login';
    } else {
      loginBadgeText.textContent = 'Modo Local Ativo';
    }
  }

  const tabBadge = document.getElementById('users-supabase-table-badge');
  if (tabBadge) {
    if (data.usuariosTableExists) {
      tabBadge.className = 'badge badge-success';
      tabBadge.textContent = '🟢 Tabela public.usuarios Ativa no Supabase';
    } else {
      tabBadge.className = 'badge badge-warning';
      tabBadge.textContent = '⚠️ Falta rodar o SQL da tabela public.usuarios no Supabase';
    }
  }
}

// Gerenciamento de Usuários na aba "Usuários & Acessos"
async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    if (!res.ok) return;
    const data = await res.json();
    appState.usersList = data.users || [];
    updateSupabaseAuthBadges(data);
    renderUsersTable(appState.usersList);
  } catch (_) {}
}

function renderUsersTable(users) {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;

  if (!users || users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Nenhum usuário encontrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map(u => {
    let statusBadge = '<span class="badge badge-success">✅ Ativo</span>';
    if (u.status === 'PENDING') statusBadge = '<span class="badge badge-warning">⏳ Pendente</span>';
    if (u.status === 'BLOCKED') statusBadge = '<span class="badge badge-danger">🚫 Bloqueado</span>';

    const roleBadge = u.role === 'admin'
      ? '<span class="badge badge-brand">👑 Admin</span>'
      : '<span class="badge badge-info">👤 Operador</span>';

    const lastLogin = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('pt-BR') : 'Nunca acessou';
    const username = u.username || u.email.split('@')[0];

    const changePassBtn = `<button class="btn btn-secondary btn-sm" onclick="promptChangePassword('${escapeHtml(u.email)}', '${escapeHtml(u.name || username)}')">🔑 Senha</button>`;

    let actionsHtml = '';
    if (u.isMaster) {
      actionsHtml = `<div style="display: flex; gap: 0.4rem; align-items: center;">${changePassBtn}<span style="font-size: 0.75rem; color: var(--accent-brand); font-weight: 600;">🔒 Principal</span></div>`;
    } else {
      const approveBtn = u.status !== 'APPROVED'
        ? `<button class="btn btn-primary btn-sm" onclick="changeUserStatus('${escapeHtml(u.email)}', 'APPROVED')">✅ Ativar</button>`
        : `<button class="btn btn-secondary btn-sm" onclick="changeUserStatus('${escapeHtml(u.email)}', 'BLOCKED')">🚫 Bloquear</button>`;
      const deleteBtn = `<button class="btn btn-danger btn-sm" onclick="removeUserAccount('${escapeHtml(u.email)}')">🗑️</button>`;
      actionsHtml = `<div style="display: flex; gap: 0.4rem; flex-wrap: wrap;">${changePassBtn}${approveBtn}${deleteBtn}</div>`;
    }

    return `
      <tr>
        <td><strong>${escapeHtml(u.name || '-')}</strong></td>
        <td><code style="color: var(--accent-brand); font-weight: 700;">${escapeHtml(username)}</code></td>
        <td><code style="color: var(--accent-blue);">${escapeHtml(u.email)}</code></td>
        <td>${roleBadge}</td>
        <td>${statusBadge}</td>
        <td style="font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(lastLogin)}</td>
        <td>${actionsHtml}</td>
      </tr>
    `;
  }).join('');
}

window.promptChangePassword = async function(email, name) {
  const newPass = prompt(`Digite a nova senha para "${name}" (${email}):`);
  if (!newPass || newPass.trim().length < 4) {
    if (newPass !== null) showToast('A senha deve ter pelo menos 4 caracteres.', 'error');
    return;
  }
  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: newPass.trim() })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Senha de ${name} atualizada com sucesso!`, 'success');
      renderUsersTable(data.users || []);
    } else {
      showToast(data.error || 'Erro ao alterar senha.', 'error');
    }
  } catch (_) {
    showToast('Erro ao comunicar com o servidor.', 'error');
  }
};

window.changeUserStatus = async function(email, status) {
  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, status })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Status de ${email} atualizado!`, 'success');
      renderUsersTable(data.users || []);
    } else {
      showToast(data.error || 'Erro ao atualizar usuário.', 'error');
    }
  } catch (_) {
    showToast('Erro ao comunicar com o servidor.', 'error');
  }
};

window.removeUserAccount = async function(email) {
  if (!confirm(`Deseja remover o acesso do usuário ${email}?`)) return;
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(email)}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(`Usuário ${email} removido.`, 'info');
      renderUsersTable(data.users || []);
    } else {
      showToast(data.error || 'Erro ao remover usuário.', 'error');
    }
  } catch (_) {
    showToast('Erro ao remover usuário.', 'error');
  }
};

document.getElementById('form-manage-user')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('user-form-email').value.trim();
  const name = document.getElementById('user-form-name').value.trim();
  const role = document.getElementById('user-form-role').value;
  const password = document.getElementById('user-form-password').value;

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, email, name, role, password, status: 'APPROVED' })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Usuário (${email}) salvo com sucesso no Supabase!`, 'success');
      document.getElementById('form-manage-user').reset();
      updateSupabaseAuthBadges(data);
      renderUsersTable(data.users || []);
    } else {
      showToast(data.error || 'Erro ao salvar usuário.', 'error');
    }
  } catch (_) {
    showToast('Erro ao salvar usuário.', 'error');
  }
});

// Inicialização da Autenticação e Loop de Polling
async function bootstrapApp() {
  try {
    const cfgRes = await originalFetch('/api/auth/config');
    const cfg = await cfgRes.json();
    updateSupabaseAuthBadges(cfg);
  } catch (_) {}

  const token = localStorage.getItem('trade_hub_token');
  if (!token) {
    showAuthOverlay();
  } else {
    try {
      const meRes = await fetch('/api/auth/me');
      if (meRes.ok) {
        const meData = await meRes.json();
        hideAuthOverlay(meData.user);
        startDashboardAll();
      } else {
        showAuthOverlay();
      }
    } catch (_) {
      showAuthOverlay();
    }
  }
}

bootstrapApp();

// Polling a cada 4 segundos (somente quando autenticado)
setInterval(() => {
  if (appState.currentUser) {
    checkWhatsAppStatus();
    checkQueue();
  }
}, 4000);

// Polling de histórico a cada 10 segundos (somente quando autenticado)
setInterval(() => {
  if (appState.currentUser) {
    loadHistory();
  }
}, 10000);
