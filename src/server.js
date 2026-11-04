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
  console.log(`Content-Type: ${req.headers['content-type']}`);
  console.log(`Payload Recebido:`, typeof req.body === 'object' ? JSON.stringify(req.body, null, 2).substring(0, 800) : req.body);
  try {
    const fs = require('fs');
    fs.writeFileSync(path.join(__dirname, '../data/last_raw_webhook.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
      body: req.body
    }, null, 2), 'utf-8');
  } catch (_) {}
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

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(Storage.getHistory(limit));
});

// -------------------------------------------------------------
// 5. SIMULADOR DE ATIVIDADE UMOV.ME (Teste imediato)
// -------------------------------------------------------------
app.post('/api/simulate', async (req, res) => {
  try {
    const { promoterName, pdvName, pdvCode, activityName, clientName, networkName, notes, photos } = req.body;
    
    const client = clientName || 'Arroz Fantástico';
    const network = networkName || 'Mundial';
    const pdv = pdvName || `Supermercados ${network} - Loja Barra`;

    const simulatedPayload = {
      id: `SIM-${Math.floor(100000 + Math.random() * 900000)}`,
      agent: { name: promoterName || 'Carlos Silva - Promotor' },
      local: {
        name: pdv,
        code: pdvCode || '1042',
        clientName: client,
        network: network,
        rede: network
      },
      activityType: { name: activityName || 'Reposição e Ponto Extra (Frente de Caixa)' },
      endDate: new Date().toISOString(),
      notes: notes || 'Ponto extra montado com sucesso, gondola 100% abastecida.',
      attachments: (photos && photos.length > 0) ? photos : [
        {
          type: 'PHOTO',
          url: 'https://images.unsplash.com/photo-1578916171728-46686eac8d58?w=800&auto=format&fit=crop&q=80',
          name: 'gondola_arroz.jpg'
        },
        {
          type: 'PHOTO',
          url: 'https://images.unsplash.com/photo-1534723452862-4c874018d66d?w=800&auto=format&fit=crop&q=80',
          name: 'ponto_extra_arroz.jpg'
        }
      ]
    };

    const context = {
      urlClient: client,
      urlNetwork: network
    };

    const activity = UmovmeParser.extractActivityData(simulatedPayload, context);
    const targetGroups = MessageRouter.resolveTargetGroups(activity, context);

    if (targetGroups.length === 0) {
      return res.status(400).json({
        success: false,
        error: `Nenhum grupo de WhatsApp mapeado para Cliente: "${client}" e Rede: "${network}". Cadastre a regra na aba "Mapeamento".`
      });
    }

    const queueItem = dispatchQueue.enqueueActivity(activity, targetGroups);

    res.json({
      success: true,
      message: `Atividade simulada criada para [${client} ➔ Rede ${network}] e enviada para ${targetGroups.length} grupo(s)!`,
      activity,
      targetGroups,
      queueId: queueItem.id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Inicialização do servidor e do WhatsApp
app.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Trade Marketing - Automação Umov.me ➔ WhatsApp`);
  console.log(`📡 Painel Web & Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 Webhook Geral: http://localhost:${PORT}/api/webhook/umovme`);
  console.log(`🔗 Webhook por Cliente/Rede: http://localhost:${PORT}/api/webhook/umovme/:cliente/:rede`);
  console.log(`⚡ Supabase: https://vuvchcevhezkxhmlxgrz.supabase.co`);
  console.log(`======================================================\n`);

  // Iniciar sincronizador do Supabase de imediato
  supabaseWorker.init();

  // Iniciar cliente nativo WhatsApp Baileys em paralelo
  whatsappManager.init().catch(err => {
    console.error('[WhatsApp] Falha ao iniciar:', err?.message || err);
  });
});
