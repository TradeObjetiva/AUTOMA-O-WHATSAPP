const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('[Proteção 24h] Erro não capturado tratado:', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Proteção 24h] Rejeição de Promise tratada:', reason?.message || reason);
});

const Storage = require('./storage');
const whatsappManager = require('./whatsapp');
const UmovmeParser = require('./parser');
const MessageRouter = require('./router');
const dispatchQueue = require('./queue');
const supabaseWorker = require('./supabaseWorker');
const authManager = require('./auth');

const app = express();
const settings = Storage.getSettings();
const PORT = process.env.PORT || settings.general?.port || 3000;

const { XMLParser } = require('fast-xml-parser');
const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text({ type: ['*/xml', 'application/xml', 'text/xml'], limit: '50mb' }));

// Middleware para decodificar XML automaticamente se o uMov.me enviar XML
app.use((req, res, next) => {
  if (typeof req.body === 'string' && (req.body.trim().startsWith('<') || req.headers['content-type']?.includes('xml'))) {
    try {
      req.body = xmlParser.parse(req.body);
    } catch (e) {
      console.warn('[Parser] Falha ao converter corpo XML:', e.message);
    }
  }
  next();
});

// Middleware de log detalhado para qualquer webhook recebido
app.use(['/api/webhook', '/webhook'], (req, res, next) => {
  console.log(`\n======================================================`);
  console.log(`📥 [NOVA REQUISIÇÃO WEBHOOK] ${req.method} ${req.originalUrl}`);
  console.log(`🌐 IP Origem: ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
  next();
});

// Servir frontend dashboard
app.use(express.static(path.join(__dirname, '../public')));

// Health check para Render, UptimeRobot e monitoramento de disponibilidade
app.get(['/health', '/api/status', '/healthz'], (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.5',
    uptime: Math.round(process.uptime()),
    whatsapp: whatsappManager.status,
    supabaseActive: supabaseWorker.enabled,
    supabaseError: supabaseWorker.lastError || null,
    timestamp: new Date().toISOString()
  });
});

// -------------------------------------------------------------
// 1. ENDPOINTS WEBHOOK UMOV.ME (Recepção por Cliente e Rede)
// -------------------------------------------------------------
const handleUmovmeWebhook = async (req, res) => {
  const payload = req.body;
  const context = {
    urlClient: req.params.client || req.query.client || req.query.cliente || null,
    urlNetwork: req.params.network || req.query.network || req.query.rede || null
  };

  console.log(`[Webhook uMov.me] Recebida requisição POST. Rota: ${req.originalUrl} | Contexto: [Cliente: ${context.urlClient || 'N/A'}, Rede: ${context.urlNetwork || 'N/A'}]`);

  try {
    const activity = UmovmeParser.extractActivityData(payload, context);
    console.log(`[Webhook uMov.me] Atividade #${activity.activityId} extraída. Cliente: ${activity.clientName} | Rede: ${activity.networkName || activity.pdvName} | Fotos: ${activity.photoUrls.length}`);

    const targetGroups = MessageRouter.resolveTargetGroups(activity, context);

    if (targetGroups.length === 0) {
      console.warn(`[Webhook uMov.me] ⚠️ Nenhum grupo de WhatsApp encontrado para Cliente "${activity.clientName}" e Rede "${activity.networkName || activity.pdvName}".`);
      Storage.addHistoryEntry({
        activityId: activity.activityId,
        clientName: activity.clientName,
        networkName: activity.networkName,
        pdvName: activity.pdvName,
        promoterName: activity.promoterName,
        activityName: activity.activityName,
        date: activity.date,
        photoCount: activity.photoUrls.length,
        targetGroups: ['Nenhum grupo mapeado'],
        status: 'IGNORED_NO_GROUP',
        error: `Sem regra para Cliente: "${activity.clientName}" e Rede: "${activity.networkName || activity.pdvName}"`
      });

      return res.status(200).json({
        success: true,
        message: 'Atividade recebida, porém nenhum grupo destinatário foi mapeado para esta combinação de Cliente e Rede.',
        activityId: activity.activityId,
        client: activity.clientName,
        network: activity.networkName
      });
    }

    // Adicionar à fila de envio anti-ban
    const queueItem = dispatchQueue.enqueueActivity(activity, targetGroups);

    return res.status(200).json({
      success: true,
      message: 'Atividade recebida e enfileirada para envio nos grupos com sucesso.',
      activityId: activity.activityId,
      queueId: queueItem.id,
      client: activity.clientName,
      network: activity.networkName,
      groups: targetGroups.map(g => g.name)
    });

  } catch (err) {
    console.error('[Webhook uMov.me] Erro ao processar payload:', err);
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// Rotas flexíveis para uMov.me: Geral, por Cliente ou por Cliente + Rede
app.post([
  '/api/webhook/umovme',
  '/webhook/umovme',
  '/webhook'
], handleUmovmeWebhook);

app.post([
  '/api/webhook/umovme/:client',
  '/webhook/umovme/:client',
  '/api/webhook/:client',
  '/webhook/:client'
], handleUmovmeWebhook);

app.post([
  '/api/webhook/umovme/:client/:network',
  '/webhook/umovme/:client/:network',
  '/api/webhook/:client/:network',
  '/webhook/:client/:network'
], handleUmovmeWebhook);

// -------------------------------------------------------------
// 1.5. AUTENTICAÇÃO E GESTÃO DE USUÁRIOS (TABELA USUARIOS SUPABASE)
// -------------------------------------------------------------
app.get('/api/auth/config', async (req, res) => {
  try {
    const status = await authManager.getStatusReport();
    res.json(status);
  } catch (err) {
    res.json({ supabaseConnected: false, usuariosTableExists: false });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const result = await authManager.loginWithPassword(username || email, password);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, name, password } = req.body;
    const result = await authManager.registerAccount({ username, email, name, password });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  return authManager.requireAuth(req, res, () => {
    res.json({
      success: true,
      user: {
        username: req.user.username || req.user.email.split('@')[0],
        email: req.user.email,
        name: req.user.name,
        role: req.user.role
      }
    });
  });
});

// Middleware de proteção para todas as rotas administrativas abaixo
const protectApi = (req, res, next) => authManager.requireAuth(req, res, next);
app.use(['/api/whatsapp', '/api/mappings', '/api/settings', '/api/queue', '/api/history', '/api/simulate', '/api/users'], protectApi);

// Rotas de Gerenciamento de Usuários (Aba Usuários & Acessos)
app.get('/api/users', async (req, res) => {
  const status = await authManager.getStatusReport();
  res.json({
    users: authManager.getPublicUsersList(),
    ...status
  });
});

app.post('/api/users', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem gerenciar usuários.' });
    }
    const { username, email, name, role, password, status } = req.body;
    const users = await authManager.adminAddOrUpdateUser({ username, email, name, role, password, status });
    const report = await authManager.getStatusReport();
    return res.json({ success: true, users, ...report });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:email', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem remover usuários.' });
    }
    const users = await authManager.adminDeleteUser(decodeURIComponent(req.params.email));
    res.json({ success: true, users });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 2. ENDPOINTS WHATSAPP (Status, Conexão, QR Code, Grupos)
// -------------------------------------------------------------
app.get('/api/whatsapp/status', (req, res) => {
  res.json(whatsappManager.getStatus());
});

app.post('/api/whatsapp/logout', async (req, res) => {
  const ok = await whatsappManager.logout();
  res.json({ success: ok });
});

app.post('/api/whatsapp/reset', async (req, res) => {
  const ok = await whatsappManager.resetSession();
  res.json({ success: ok, message: 'Sessão reiniciada. Novo QR Code em geração.' });
});

app.get('/api/whatsapp/groups', async (req, res) => {
  const force = req.query.force === 'true';
  const groups = await whatsappManager.getGroups(force);
  res.json({
    connected: whatsappManager.status === 'CONNECTED',
    count: groups.length,
    groups
  });
});

app.post('/api/whatsapp/test-group', async (req, res) => {
  try {
    const { groupId, groupName, clientName } = req.body;
    if (!groupId) {
      return res.status(400).json({ error: 'ID do grupo não informado.' });
    }
    const text = `✅ *Teste de Conexão — Trade Marketing Hub*\nGrupo ativo: *${groupName || groupId}*\nCliente/Regra: *${clientName || 'Geral'}*\nHorário: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
    await whatsappManager.sendTextMessage(groupId, text);
    res.json({ success: true, message: `Mensagem de teste enviada ao grupo "${groupName || groupId}"!` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 3. ENDPOINTS DE MAPEAMENTOS E REGRAS (CLIENTES E REDES)
// -------------------------------------------------------------
app.get('/api/mappings', (req, res) => {
  if (!supabaseWorker.enabled) {
    supabaseWorker.init();
  }
  const mappings = Storage.getMappings();
  const webhookBaseUrl = supabaseWorker.getWebhookBaseUrl();
  res.json({
    rules: mappings.rules || [],
    webhookBaseUrl,
    supabaseUrl: process.env.SUPABASE_URL || 'https://vuvchcevhezkxhmlxgrz.supabase.co',
    isSupabaseActive: supabaseWorker.enabled,
    supabaseError: supabaseWorker.lastError || null
  });
});

app.post('/api/mappings', async (req, res) => {
  const { name, client, network, matchType, matchValue, targetGroupId, targetGroupName, active } = req.body;
  if (!targetGroupId) {
    return res.status(400).json({ error: 'targetGroupId é obrigatório.' });
  }

  const slugify = (text) => (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  const clientClean = (client || '').trim();
  const networkClean = (network || '').trim();

  let autoName = name;
  if (!autoName) {
    if (clientClean && networkClean) {
      autoName = `${clientClean} - Rede ${networkClean}`;
    } else if (clientClean) {
      autoName = `${clientClean} - Geral`;
    } else {
      autoName = `Regra ${matchValue || targetGroupName}`;
    }
  }

  const routeSlug = clientClean ? `${slugify(clientClean)}${networkClean ? '/' + slugify(networkClean) : ''}` : '';
  const webhookBaseUrl = supabaseWorker.getWebhookBaseUrl();
  const dedicatedWebhookUrl = routeSlug ? `${webhookBaseUrl}/${routeSlug}` : webhookBaseUrl;

  const newRule = {
    id: `rule-${Date.now()}`,
    name: autoName,
    client: clientClean,
    network: networkClean,
    routeSlug,
    matchType: matchType || (clientClean && networkClean ? 'matrix' : 'pdv_contains'),
    matchValue: matchValue || (networkClean || clientClean),
    targetGroupId,
    targetGroupName: targetGroupName || targetGroupId,
    active: active !== false
  };

  const updated = Storage.addRule(newRule);
  await supabaseWorker.addRule(newRule);

  res.json({
    success: true,
    rule: newRule,
    webhookUrl: dedicatedWebhookUrl,
    webhookBaseUrl,
    mappings: updated
  });
});

app.delete('/api/mappings/:id', async (req, res) => {
  const updated = Storage.deleteRule(req.params.id);
  await supabaseWorker.deleteRule(req.params.id);
  res.json({ success: true, mappings: updated });
});

// -------------------------------------------------------------
// 4. ENDPOINTS DE CONFIGURAÇÕES E FILA
// -------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  res.json(Storage.getSettings());
});

app.post('/api/settings', (req, res) => {
  const updated = Storage.updateSettings(req.body);
  res.json({ success: true, settings: updated });
});

app.get('/api/queue', (req, res) => {
  res.json(dispatchQueue.getQueueStatus());
});

app.get('/api/history', async (req, res) => {
  try {
    const history7d = await supabaseWorker.getHistoryLast7Days();
    res.json(history7d);
  } catch (err) {
    const limit = parseInt(req.query.limit) || 200;
    res.json(Storage.getHistory(limit));
  }
});

app.post('/api/history/retry-all-failed', async (req, res) => {
  try {
    const result = await supabaseWorker.retryAllFailed();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/history/retry/:id', async (req, res) => {
  try {
    const result = await supabaseWorker.retryActivity(decodeURIComponent(req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Desligamento gracioso (SIGTERM/SIGINT) para deploys no Render sem derrubar a sessão do WhatsApp
const handleShutdown = async (signal) => {
  console.log(`\n[Server] Recebido ${signal}. Encerrando conexão WhatsApp com segurança antes de finalizar...`);
  await whatsappManager.gracefulShutdown();
  process.exit(0);
};
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Inicialização do servidor e do WhatsApp
app.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Trade Marketing - Automação Umov.me ➔ WhatsApp`);
  console.log(`📡 Painel Web & Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 Webhook Geral: http://localhost:${PORT}/api/webhook/umovme`);
  console.log(`🔗 Webhook por Cliente/Rede: http://localhost:${PORT}/api/webhook/umovme/:cliente/:rede`);
  console.log(`⚡ Supabase: https://vuvchcevhezkxhmlxgrz.supabase.co`);
  console.log(`======================================================\n`);

  // Iniciar gerenciador de usuários e autenticação Google
  authManager.init().catch(err => {
    console.error('[Auth] Erro ao inicializar:', err?.message || err);
  });

  // Iniciar sincronizador do Supabase de imediato
  supabaseWorker.init();

  // Iniciar cliente nativo WhatsApp Baileys em paralelo
  whatsappManager.init().catch(err => {
    console.error('[WhatsApp] Falha ao iniciar:', err?.message || err);
  });

  // Auto-Ping Keep-Alive a cada 10 minutos para evitar hibernação no Render Free
  const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://automa-o-whatsapp-hghk.onrender.com';
  setInterval(() => {
    const axios = require('axios');
    axios.get(`${externalUrl}/health`).catch(() => {});
  }, 10 * 60 * 1000);
});
