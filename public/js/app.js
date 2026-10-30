let appState = {
  waStatus: 'DISCONNECTED',
  groups: [],
  mappings: { rules: [] },
  settings: {},
  history: [],
  queue: {},
  webhookBaseUrl: 'https://vuvchcevhezkxhmlxgrz.supabase.co/functions/v1/umovme-webhook'
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

// 4. Feed de Atividades & Histórico
async function loadHistory() {
  try {
    const res = await fetch('/api/history?limit=30');
    appState.history = await res.json();
    statActivitiesCount.textContent = appState.history.length;
    renderActivityFeed(appState.history);
  } catch (err) {
    console.error('Erro ao carregar histórico:', err);
  }
}

function renderActivityFeed(items) {
  if (!items || items.length === 0) {
    activityFeedList.innerHTML = `
      <p style="text-align: center; color: var(--text-muted); padding: 2rem;">
        Nenhuma atividade recebida até o momento.
      </p>
    `;
    return;
  }

  activityFeedList.innerHTML = items.map(item => {
    let statusBadge = '<span class="badge badge-warning">Na Fila</span>';
    if (item.status === 'COMPLETED') statusBadge = '<span class="badge badge-success">Disparado no WhatsApp</span>';
    if (item.status === 'PROCESSING') statusBadge = '<span class="badge badge-info">Enviando Fotos...</span>';
    if (item.status === 'FAILED') statusBadge = '<span class="badge badge-danger">Falha no Envio</span>';
    if (item.status === 'IGNORED_NO_GROUP') statusBadge = '<span class="badge badge-warning">Sem Grupo Mapeado</span>';

    return `
      <div class="activity-item">
        <div class="activity-avatar">📸</div>
        <div class="activity-details">
          <div class="activity-header-line">
            <span class="activity-title-text">${escapeHtml(item.pdvName || 'PDV')} &bull; ${escapeHtml(item.activityName || 'Atividade')}</span>
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

// Inicialização e Loop de Polling
checkWhatsAppStatus();
loadSettings();
loadMappings();
loadHistory();
checkQueue();

// Polling a cada 3 segundos para manter status em tempo real
setInterval(() => {
  checkWhatsAppStatus();
  checkQueue();
}, 3000);

// Polling de histórico a cada 8 segundos
setInterval(() => {
  loadHistory();
}, 8000);
