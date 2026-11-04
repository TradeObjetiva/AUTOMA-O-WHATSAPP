let appState = {
  waStatus: 'DISCONNECTED',
  groups: [],
  mappings: { rules: [] },
  settings: {},
  history: [],
  queue: {},
  currentUser: null,
  usersList: [],
  webhookBaseUrl: 'https://vuvchcevhezkxhmlxgrz.supabase.co/functions/v1/umovme-webhook'
};

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
const statGroupsCount = document.getElementById('stat-groups-count');
const statActivitiesCount = document.getElementById('stat-activities-count');
const statQueueCount = document.getElementById('stat-queue-count');
const waConnectionView = document.getElementById('wa-connection-view');
const waActions = document.getElementById('wa-connection-actions');
const groupsTableBody = document.getElementById('groups-table-body');
const rulesTableBody = document.getElementById('rules-table-body');
const activityFeedList = document.getElementById('activity-feed-list');
const webhookUrlDisplay = document.getElementById('webhook-url-display');

// Setup initial webhook URL
if (webhookUrlDisplay) {
  webhookUrlDisplay.textContent = appState.webhookBaseUrl;
}

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
    if (tabId === 'tab-feed') loadHistory();
    if (tabId === 'tab-users') loadUsers();
    if (tabId === 'tab-settings') loadSettings();
  });
});

// 1. WhatsApp Status & QR Code Polling
async function checkWhatsAppStatus() {
  try {
    const res = await fetch('/api/whatsapp/status');
    const data = await res.json();
    appState.waStatus = data.status;

    // Atualizar badge do header
    statusBadge.className = `status-badge ${data.status.toLowerCase()}`;
    
    if (data.status === 'CONNECTED') {
      statusText.textContent = `Online: ${data.user?.name || 'WhatsApp'}`;
      statWaStatus.textContent = 'Conectado';
      statWaStatus.style.color = 'var(--accent-wa)';
      renderConnectedView(data.user);
    } else if (data.status === 'QR_READY') {
      statusText.textContent = 'Aguardando Leitura QR';
      statWaStatus.textContent = 'Escanear QR';
      statWaStatus.style.color = 'var(--accent-amber)';
      renderQRView(data.qrCodeDataUrl);
    } else if (data.status === 'CONNECTING') {
      statusText.textContent = 'Conectando...';
      statWaStatus.textContent = 'Conectando';
      statWaStatus.style.color = 'var(--accent-blue)';
      renderConnectingView();
    } else {
      statusText.textContent = 'Desconectado';
      statWaStatus.textContent = 'Desconectado';
      statWaStatus.style.color = 'var(--accent-red)';
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
          <h3 style="font-size: 1.1rem; color: var(--text-main); font-weight: 700;">${user?.name || 'Conta Conectada'}</h3>
          <p style="font-size: 0.85rem; color: var(--text-muted);">${user?.id || 'ID Ativo'}</p>
          <span class="badge badge-success" style="margin-top: 0.4rem;">Ativo para Disparos 24h</span>
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
      <div class="pulse-dot" style="width: 20px; height: 20px; margin-bottom: 1rem; color: var(--accent-blue);"></div>
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

// 2. Grupos de WhatsApp
async function loadGroups(force = false) {
  try {
    const res = await fetch(`/api/whatsapp/groups${force ? '?force=true' : ''}`);
    const data = await res.json();
    appState.groups = data.groups || [];
    statGroupsCount.textContent = data.count || 0;
    renderGroupsTable(appState.groups);
  } catch (err) {
    console.error('Erro ao carregar grupos:', err);
  }
}

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
        <div style="display: flex; gap: 0.5rem;">
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

// Filtro de grupos
document.getElementById('search-groups')?.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  const filtered = appState.groups.filter(g => g.subject.toLowerCase().includes(query) || g.id.toLowerCase().includes(query));
  renderGroupsTable(filtered);
});

document.getElementById('btn-refresh-groups')?.addEventListener('click', () => loadGroups(true));

// 3. Mapeamentos de Regras
async function loadMappings() {
  try {
    const res = await fetch('/api/mappings');
    const data = await res.json();
    appState.mappings = data;
    if (data.webhookBaseUrl) {
      appState.webhookBaseUrl = data.webhookBaseUrl;
      if (webhookUrlDisplay) {
        webhookUrlDisplay.textContent = data.webhookBaseUrl;
      }
    }
    renderRulesTable(appState.mappings.rules || []);
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

    return `
      <tr>
        <td>
          <strong style="color: var(--accent-wa); font-size: 0.95rem;">🏷️ ${escapeHtml(clientName)}</strong>
        </td>
        <td>
          <span class="badge ${r.network ? 'badge-info' : 'badge-warning'}">
            🏪 ${escapeHtml(networkName)}
          </span>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <code style="color: #38bdf8; font-size: 0.78rem; background: rgba(0,0,0,0.35); padding: 0.25rem 0.55rem; border-radius: 6px; word-break: break-all; border: 1px solid rgba(56, 189, 248, 0.25);">
              ${webhookUrl}
            </code>
            <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${webhookUrl}', 'URL do Webhook Supabase [${escapeHtml(clientName)} - ${escapeHtml(networkName)}] copiada com sucesso!')" title="Copiar URL para colocar na Umov.me">
              📋 Copiar
            </button>
          </div>
        </td>
        <td>
          <div><strong>${escapeHtml(r.targetGroupName || 'Grupo')}</strong></div>
          <div style="font-size: 0.75rem; color: var(--text-dim);">${r.targetGroupId || '<span style="color:var(--accent-red)">JID pendente</span>'}</div>
        </td>
        <td>
          <span class="badge ${r.active ? 'badge-success' : 'badge-danger'}">
            ${r.active ? 'Ativa' : 'Inativa'}
          </span>
        </td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="deleteRule('${r.id}')">🗑️ Excluir</button>
        </td>
      </tr>
    `;
  }).join('');
}

// Alternar formulário nova regra
const formCard = document.getElementById('form-new-rule-card');
document.getElementById('btn-toggle-add-rule')?.addEventListener('click', () => {
  formCard.style.display = formCard.style.display === 'none' ? 'block' : 'none';
  updateRuleUrlPreview();
});
document.getElementById('btn-cancel-rule')?.addEventListener('click', () => {
  formCard.style.display = 'none';
});

// Modal de webhook gerado
function showWebhookGeneratedModal({ client, network, groupName, url }) {
  const modal = document.getElementById('modal-webhook-created');
  if (!modal) {
    showToast(`Webhook gerado no Supabase: ${url}`, 'success');
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
    const res = await fetch('/api/mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ruleData)
    });
    const data = await res.json();
    if (res.ok) {
      formCard.style.display = 'none';
      document.getElementById('form-new-rule').reset();
      loadMappings();

      const base = data.webhookBaseUrl || appState.webhookBaseUrl || 'https://vuvchcevhezkxhmlxgrz.supabase.co/functions/v1/umovme-webhook';
      const slug = ruleData.client ? `${slugifyClient(ruleData.client)}${ruleData.network ? '/' + slugifyClient(ruleData.network) : ''}` : '';
      const generatedUrl = data.webhookUrl || (slug ? `${base}/${slug}` : base);

      showWebhookGeneratedModal({
        client: ruleData.client,
        network: ruleData.network || 'Todas as Redes (Geral)',
        groupName: ruleData.targetGroupName,
        url: generatedUrl
      });
      showToast('Nova combinação criada com sucesso no Supabase!', 'success');
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

// 4. Feed de Atividades & Histórico de 7 Dias com Filtros
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

function populateFeedFilterOptions(items) {
  const daySelect = document.getElementById('feed-filter-day');
  const promoterSelect = document.getElementById('feed-filter-promoter');

  // 1. Popular últimos 7 dias
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

  // 2. Popular promotores únicos (filtrados pelo dia selecionado, se houver)
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

  // Filtrar primeiro por Dia, Promotor e Busca para calcular os contadores de Enviados vs Pendentes daquele recorte
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

  for (const item of baseFiltered) {
    if (item.status === 'COMPLETED') sentCount++;
    else if (item.status === 'QUEUED' || item.status === 'PROCESSING') pendingCount++;
    else failedCount++;
  }

  // Filtrar pelo Status selecionado
  const finalItems = baseFiltered.filter(item => {
    if (statusVal === 'SENT') return item.status === 'COMPLETED';
    if (statusVal === 'PENDING') return item.status === 'QUEUED' || item.status === 'PROCESSING';
    if (statusVal === 'FAILED') return item.status === 'FAILED' || item.status === 'IGNORED_NO_GROUP';
    return true;
  });

  // Atualizar contadores no topo do Feed
  const elTotal = document.getElementById('count-feed-total');
  const elSent = document.getElementById('count-feed-sent');
  const elPending = document.getElementById('count-feed-pending');
  const elFailed = document.getElementById('count-feed-failed');

  if (elTotal) elTotal.textContent = finalItems.length;
  if (elSent) elSent.textContent = sentCount;
  if (elPending) elPending.textContent = pendingCount;
  if (elFailed) elFailed.textContent = failedCount;

  renderActivityFeed(finalItems);
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history?limit=1000');
    appState.history = await res.json();
    statActivitiesCount.textContent = appState.history.length;
    populateFeedFilterOptions(appState.history);
    applyFeedFiltersAndRender();
  } catch (err) {
    console.error('Erro ao carregar histórico:', err);
  }
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

  activityFeedList.innerHTML = items.map(item => {
    let statusBadge = '<span class="badge badge-warning">⏳ Pendente / Na Fila</span>';
    if (item.status === 'COMPLETED') statusBadge = '<span class="badge badge-success">✅ Enviado no WhatsApp</span>';
    if (item.status === 'PROCESSING') statusBadge = '<span class="badge badge-info">📤 Enviando Fotos Agora...</span>';
    if (item.status === 'FAILED') statusBadge = '<span class="badge badge-danger">❌ Falha no Envio</span>';
    if (item.status === 'IGNORED_NO_GROUP') statusBadge = '<span class="badge badge-warning">⚠️ Sem Grupo Mapeado</span>';

    const clientTag = item.clientName
      ? `<span class="badge badge-info" style="margin-right: 0.4rem;">🏷️ ${escapeHtml(item.clientName)}</span>`
      : '';

    return `
      <div class="activity-item">
        <div class="activity-avatar">${item.status === 'COMPLETED' ? '✅' : item.status === 'PROCESSING' ? '📤' : '📸'}</div>
        <div class="activity-details">
          <div class="activity-header-line">
            <span class="activity-title-text">${clientTag}${escapeHtml(item.pdvName || 'PDV')} &bull; ${escapeHtml(item.activityName || 'Atividade')}</span>
            ${statusBadge}
          </div>
          <div class="activity-meta">
            <span>👤 Promotor: <strong>${escapeHtml(item.promoterName || 'N/A')}</strong></span>
            <span>📅 ${escapeHtml(item.date || '')}</span>
            <span>🖼️ ${item.photoCount || 0} fotos</span>
            <span>🎯 Grupos: <em>${escapeHtml((item.targetGroups || []).join(', '))}</em></span>
          </div>
          ${item.error ? `<div style="color: var(--accent-red); font-size: 0.8rem; margin-top: 0.4rem;">Erro: ${escapeHtml(item.error)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

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

// 5. Simulador
document.getElementById('form-simulator')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btn-submit-simulate');
  btn.disabled = true;
  btn.textContent = 'Enviando atividade de teste...';

  const photoLines = document.getElementById('sim-photos').value
    .split('\n')
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(url => ({ type: 'PHOTO', url, name: 'foto.jpg' }));

  const payload = {
    clientName: document.getElementById('sim-client')?.value || 'Arroz Fantástico',
    networkName: document.getElementById('sim-network')?.value || 'Mundial',
    pdvName: document.getElementById('sim-pdv')?.value || 'Supermercados Mundial - Loja Barra',
    promoterName: document.getElementById('sim-promoter')?.value || 'Carlos Silva - Promotor',
    activityName: document.getElementById('sim-activity')?.value || 'Ponto Extra e Abastecimento de Gôndola',
    notes: document.getElementById('sim-notes')?.value || '',
    photos: photoLines
  };

  try {
    const res = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      showToast('Atividade de teste recebida e enfileirada!', 'success');
      // Trocar para a aba de feed
      document.querySelector('[data-tab=tab-feed]').click();
      loadHistory();
      checkQueue();
    } else {
      showToast(data.error || 'Erro na simulação.', 'error');
    }
  } catch (err) {
    showToast('Erro ao disparar simulação.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Disparar Atividade de Teste Agora';
  }
});

// 6. Configurações
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    appState.settings = await res.json();
    const s = appState.settings;

    if (s.queue) {
      document.getElementById('setting-min-delay').value = s.queue.minDelaySeconds || 3;
      document.getElementById('setting-max-delay').value = s.queue.maxDelaySeconds || 7;
      document.getElementById('setting-caption-template').value = s.queue.captionTemplate || '';
    }

    if (s.defaultGroup) {
      document.getElementById('setting-default-group-id').value = s.defaultGroup.groupId || '';
      document.getElementById('setting-default-group-name').value = s.defaultGroup.groupName || '';
    }

    if (s.umovme) {
      document.getElementById('setting-umovme-appid').value = s.umovme.appId || '';
      document.getElementById('setting-umovme-appkey').value = s.umovme.appKey || '';
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
      minDelaySeconds: parseInt(document.getElementById('setting-min-delay').value) || 3,
      maxDelaySeconds: parseInt(document.getElementById('setting-max-delay').value) || 7,
      captionTemplate: document.getElementById('setting-caption-template').value
    },
    defaultGroup: {
      enabled: true,
      groupId: document.getElementById('setting-default-group-id').value.trim(),
      groupName: document.getElementById('setting-default-group-name').value.trim()
    },
    umovme: {
      appId: document.getElementById('setting-umovme-appid').value.trim(),
      appKey: document.getElementById('setting-umovme-appkey').value.trim(),
      downloadTimeoutMs: 15000
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

// Fila polling
async function checkQueue() {
  try {
    const res = await fetch('/api/queue');
    const data = await res.json();
    appState.queue = data;
    statQueueCount.textContent = `${data.pendingCount} pendente(s)`;
    if (data.isProcessing) {
      statQueueCount.style.color = 'var(--accent-amber)';
    } else {
      statQueueCount.style.color = 'var(--text-main)';
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

document.getElementById('btn-copy-webhook')?.addEventListener('click', () => {
  const url = document.getElementById('webhook-url-display').textContent;
  copyToClipboard(url, 'URL do Webhook copiada!');
});

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

// -------------------------------------------------------------
// 7. AMBIENTE DE LOGIN E SENHA INTERATIVO (CONECTADO AO SUPABASE)
// -------------------------------------------------------------
const authOverlay = document.getElementById('auth-overlay');
const authAlertBox = document.getElementById('auth-alert-box');
const formAuthLogin = document.getElementById('form-auth-login');
const formAuthRegister = document.getElementById('form-auth-register');
const btnModeLogin = document.getElementById('btn-auth-mode-login');
const btnModeRegister = document.getElementById('btn-auth-mode-register');
let cachedUsuariosSql = '';

// Preenchimento rápido de usuário em 1 clique
window.quickFillLogin = function(username) {
  hideAuthAlert();
  const emailInput = document.getElementById('login-email');
  const passInput = document.getElementById('login-password');
  if (emailInput) emailInput.value = username;
  if (passInput) passInput.focus();
};

// Botão Mostrar/Ocultar senha no Login
document.getElementById('btn-toggle-login-pass')?.addEventListener('click', (e) => {
  const input = document.getElementById('login-password');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    e.currentTarget.textContent = '🙈';
  } else {
    input.type = 'password';
    e.currentTarget.textContent = '👁️';
  }
});

// Botão Mostrar/Ocultar senha no Cadastro
document.getElementById('btn-toggle-register-pass')?.addEventListener('click', (e) => {
  const input = document.getElementById('register-password');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    e.currentTarget.textContent = '🙈';
  } else {
    input.type = 'password';
    e.currentTarget.textContent = '👁️';
  }
});

function showAuthAlert(msg, type = 'error') {
  if (!authAlertBox) return;
  authAlertBox.style.display = 'block';
  if (type === 'success') {
    authAlertBox.style.background = 'rgba(34, 197, 94, 0.15)';
    authAlertBox.style.border = '1px solid rgba(34, 197, 94, 0.45)';
    authAlertBox.style.color = '#4ade80';
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
  btnModeLogin.className = 'btn btn-primary btn-sm';
  btnModeRegister.className = 'btn btn-secondary btn-sm';
  formAuthLogin.style.display = 'block';
  formAuthRegister.style.display = 'none';
});

btnModeRegister?.addEventListener('click', () => {
  hideAuthAlert();
  btnModeRegister.className = 'btn btn-primary btn-sm';
  btnModeLogin.className = 'btn btn-secondary btn-sm';
  formAuthRegister.style.display = 'block';
  formAuthLogin.style.display = 'none';
});

function startDashboardAll() {
  checkWhatsAppStatus();
  loadSettings();
  loadMappings();
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
  if (data.sqlScript) cachedUsuariosSql = data.sqlScript;

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
  const sqlTitle = document.getElementById('supabase-sql-title');
  const sqlDesc = document.getElementById('supabase-sql-desc');
  const sqlPreview = document.getElementById('usuarios-sql-preview');

  if (sqlPreview && cachedUsuariosSql) {
    sqlPreview.textContent = cachedUsuariosSql;
  }

  if (tabBadge) {
    if (data.usuariosTableExists) {
      tabBadge.className = 'badge badge-success';
      tabBadge.textContent = '🟢 Tabela public.usuarios Ativa no Supabase';
      if (sqlTitle) sqlTitle.innerHTML = '✅ Tabela <code>public.usuarios</code> conectada e sincronizada no Supabase!';
      if (sqlDesc) sqlDesc.innerHTML = 'Todos os usuários e senhas abaixo estão gravados diretamente na tabela <code>public.usuarios</code> do seu Supabase.';
    } else {
      tabBadge.className = 'badge badge-warning';
      tabBadge.textContent = '⚠️ Falta rodar o SQL da tabela public.usuarios no Supabase';
    }
  }
}

document.getElementById('btn-copy-usuarios-sql')?.addEventListener('click', () => {
  if (!cachedUsuariosSql) return;
  navigator.clipboard.writeText(cachedUsuariosSql).then(() => {
    showToast('SQL copiado! Cole no SQL Editor do Supabase e clique em Run.', 'success');
  });
});

document.getElementById('btn-toggle-usuarios-sql')?.addEventListener('click', () => {
  const pre = document.getElementById('usuarios-sql-preview');
  if (!pre) return;
  pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
});

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
      ? '<span class="badge badge-info">👑 Admin</span>'
      : '<span class="badge badge-secondary" style="background: rgba(255,255,255,0.08);">👤 Operador</span>';

    const lastLogin = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('pt-BR') : 'Nunca acessou';
    const username = u.username || u.email.split('@')[0];

    const changePassBtn = `<button class="btn btn-secondary btn-sm" onclick="promptChangePassword('${escapeHtml(u.email)}', '${escapeHtml(u.name || username)}')">🔑 Senha</button>`;

    let actionsHtml = '';
    if (u.isMaster) {
      actionsHtml = `<div style="display: flex; gap: 0.4rem; align-items: center;">${changePassBtn}<span style="font-size: 0.75rem; color: var(--accent-wa);">🔒 Principal</span></div>`;
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
        <td><code style="color: #4ade80; font-weight: 600;">${escapeHtml(username)}</code></td>
        <td><code style="color: #38bdf8;">${escapeHtml(u.email)}</code></td>
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
