require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Storage = require('./storage');
const dispatchQueue = require('./queue');
const whatsappManager = require('./whatsapp');
const UmovmeParser = require('./parser');
const MessageRouter = require('./router');

// Polyfill de WebSocket para Node < 22 (necessário para Supabase Realtime)
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    globalThis.WebSocket = require('ws');
  } catch (_) {}
}

function formatBrazilDateParts(isoString, fallbackDateExec) {
  let d = isoString ? new Date(isoString) : new Date();
  if (isNaN(d.getTime())) d = new Date();

  try {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(d);

    const map = {};
    for (const p of parts) map[p.type] = p.value;

    const dateLabel = `${map.day}/${map.month}/${map.year}`;
    const dateKey = `${map.year}-${map.month}-${map.day}`;
    const fullDisplay = `${dateLabel}, ${map.hour}:${map.minute}:${map.second}`;

    // Se houver data_execucao da uMov.me legível, podemos usar na exibição mas manter dateKey de São Paulo
    let display = fullDisplay;
    if (fallbackDateExec && typeof fallbackDateExec === 'string') {
      const cleanExec = fallbackDateExec.replace(/^Data:\s*/i, '').trim();
      const m = cleanExec.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/);
      if (m) {
        display = `${m[3]}/${m[2]}/${m[1]}, ${m[4]}`;
      } else if (/^\d{2}\/\d{2}\/\d{4}/.test(cleanExec)) {
        display = cleanExec;
      }
    }

    return { dateKey, dateLabel, display, iso: d.toISOString() };
  } catch (_) {
    const iso = d.toISOString();
    return {
      dateKey: iso.slice(0, 10),
      dateLabel: iso.slice(0, 10).split('-').reverse().join('/'),
      display: iso.replace('T', ' ').slice(0, 19),
      iso
    };
  }
}

class SupabaseWorker {
  constructor() {
    this.client = null;
    this.enabled = false;
    this.pollInterval = null;
    this.lastError = null;
    this.processingRowIds = new Set();
  }

  getWebhookBaseUrl() {
    const base = (process.env.SUPABASE_URL || 'https://vuvchcevhezkxhmlxgrz.supabase.co').replace(/\/+$/, '');
    return `${base}/functions/v1/umovme-webhook`;
  }

  async addRule(rule) {
    if (!this.enabled || !this.client) return false;
    try {
      const { error } = await this.client
        .from('regras_roteamento')
        .upsert({
          id: rule.id,
          nome: rule.name,
          cliente: rule.client,
          rede: rule.network || '',
          route_slug: rule.routeSlug || '',
          grupo_whatsapp_id: rule.targetGroupId,
          grupo_whatsapp_nome: rule.targetGroupName,
          ativo: rule.active !== false
        }, { onConflict: 'id' });

      if (error) {
        console.error('[Supabase Worker] Erro ao sincronizar regra no Supabase:', error.message);
        return false;
      }
      console.log(`[Supabase Worker] ✅ Regra "${rule.name}" sincronizada no Supabase com route_slug "${rule.routeSlug}".`);
      return true;
    } catch (err) {
      console.error('[Supabase Worker] Falha ao salvar regra no Supabase:', err.message);
      return false;
    }
  }

  async deleteRule(ruleId) {
    if (!this.enabled || !this.client) return false;
    try {
      const { error } = await this.client
        .from('regras_roteamento')
        .delete()
        .eq('id', ruleId);

      if (error) {
        console.error('[Supabase Worker] Erro ao excluir regra no Supabase:', error.message);
        return false;
      }
      console.log(`[Supabase Worker] ✅ Regra ${ruleId} removida do Supabase.`);
      return true;
    } catch (err) {
      console.error('[Supabase Worker] Falha ao excluir regra no Supabase:', err.message);
      return false;
    }
  }

  init() {
    const defaultUrl = 'https://vuvchcevhezkxhmlxgrz.supabase.co';
    const defaultKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ1dmNoY2V2aGV6a3hobWx4Z3J6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyOTMyNzAsImV4cCI6MjEwODg2OTI3MH0.Q9sxCNrwLkey11tZQA5Bye5m51v6kOa-7-TfzVzTiH0';

    let supabaseUrl = (process.env.SUPABASE_URL || defaultUrl).trim();
    let supabaseKey = (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || defaultKey).trim();

    // Auto-correção de typo no token (IkpxVCJ9 -> IkpXVCJ9)
    if (supabaseKey.includes('IkpxVCJ9')) {
      supabaseKey = supabaseKey.replace('IkpxVCJ9', 'IkpXVCJ9');
    }

    try {
      this.client = createClient(supabaseUrl, supabaseKey);
      this.enabled = true;
      this.lastError = null;
      console.log(`[Supabase Worker] ✅ Conectado ao Supabase: ${supabaseUrl}`);

      // 1. Sincronizar regras do banco de dados com local
      this.syncRulesFromSupabase();

      // 2. Recuperar atividades interrompidas (PROCESSANDO -> PENDENTE) e processar fila
      this.recoverInterruptedActivities().then(() => {
        this.processPendingActivities();
      });

      // 3. Iniciar polling resiliente a cada 5 segundos
      if (!this.pollInterval) {
        this.pollInterval = setInterval(() => {
          this.processPendingActivities();
        }, 5000);
      }

      // 4. Iniciar escuta Realtime
      this.listenRealtime();

      return true;
    } catch (err) {
      this.lastError = err.message;
      console.error('[Supabase Worker] Erro ao inicializar:', err.message);
      return false;
    }
  }

  async recoverInterruptedActivities() {
    if (!this.enabled || !this.client) return;
    try {
      const todayStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data } = await this.client
        .from('atividades_umovme')
        .update({ status: 'PENDENTE', updated_at: new Date().toISOString() })
        .eq('status', 'PROCESSANDO')
        .gte('created_at', todayStart)
        .select('id, atividade_id');

      if (data && data.length > 0) {
        console.log(`[Supabase Worker] 🔄 ${data.length} atividade(s) interrompida(s) recuperada(s) para a fila.`);
      }
    } catch (_) {}
  }

  async syncRulesFromSupabase() {
    if (!this.enabled) return;
    try {
      const { data, error } = await this.client
        .from('regras_roteamento')
        .select('*');

      if (error) {
        if (error.code === 'PGRST205') {
          console.warn('[Supabase Worker] ⚠️ Tabela "regras_roteamento" ainda não existe. Execute o script supabase_setup.sql no SQL Editor.');
        }
        return;
      }

      if (data && data.length > 0) {
        const localRules = data.map(r => ({
          id: r.id,
          name: r.nome,
          client: r.cliente,
          network: r.rede || '',
          routeSlug: r.route_slug || '',
          targetGroupId: r.grupo_whatsapp_id,
          targetGroupName: r.grupo_whatsapp_nome,
          active: r.ativo !== false
        }));

        Storage.updateMappings({ rules: localRules });
        console.log(`[Supabase Worker] 🔄 ${localRules.length} regra(s) sincronizada(s) do Supabase para o sistema local.`);
      }
    } catch (err) {
      console.error('[Supabase Worker] Erro ao sincronizar regras:', err.message);
    }
  }

  listenRealtime() {
    if (!this.enabled) return;
    try {
      this.client
        .channel('atividades_channel')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'atividades_umovme' },
          (payload) => {
            console.log('[Supabase Realtime] ⚡ Nova atividade recebida em tempo real via Supabase:', payload.new?.atividade_id);
            if (payload.new?.status === 'PENDENTE') {
              if (!whatsappManager.sock || whatsappManager.status !== 'CONNECTED') {
                console.warn('[Supabase Realtime] WhatsApp desconectado nesta instância. Mantendo atividade como PENDENTE no banco.');
                return;
              }
              this.handleActivityRow(payload.new);
            }
          }
        )
        .subscribe();
    } catch (err) {
      console.warn('[Supabase Worker] Falha ao assinar realtime:', err.message);
    }
  }

  async processPendingActivities() {
    if (!this.enabled || !whatsappManager.sock || whatsappManager.status !== 'CONNECTED') {
      return;
    }

    try {
      // 1. Auto-Recovery: Destravar atividades que ficaram presas em 'PROCESSANDO' (> 5 minutos) por causa de restart/deploy
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: stuckRows } = await this.client
        .from('atividades_umovme')
        .select('id, atividade_id, updated_at')
        .eq('status', 'PROCESSANDO')
        .lt('updated_at', fiveMinutesAgo)
        .limit(10);

      if (stuckRows && stuckRows.length > 0) {
        const activeMap = dispatchQueue.getActiveActivityMap();
        for (const s of stuckRows) {
          const actId = s.atividade_id || s.id;
          if (!activeMap[actId]) {
            this.processingRowIds.delete(s.id);
            if (s.atividade_id) this.processingRowIds.delete(s.atividade_id);
            await this.client
              .from('atividades_umovme')
              .update({ status: 'PENDENTE', updated_at: new Date().toISOString() })
              .eq('id', s.id);
            console.log(`[Supabase Worker] 🔄 Auto-Recovery: Atividade #${actId} destravada de PROCESSANDO para PENDENTE.`);
          }
        }
      }

      // 2. Processar atividades PENDENTES na fila
      const { data, error } = await this.client
        .from('atividades_umovme')
        .select('*')
        .eq('status', 'PENDENTE')
        .order('created_at', { ascending: true })
        .limit(5);

      if (error) return;

      if (data && data.length > 0) {
        for (const row of data) {
          await this.handleActivityRow(row);
        }
      }
    } catch (_) {}
  }

  async handleActivityRow(row) {
    if (!row || !row.id) return;
    if (!this.enabled || !whatsappManager.sock || whatsappManager.status !== 'CONNECTED') {
      console.warn(`[Supabase Worker] WhatsApp não conectado. Atividade #${row?.atividade_id} permanece na fila.`);
      return;
    }

    // Evitar processamento duplicado simultâneo entre Realtime e Polling
    if (this.processingRowIds.has(row.id) || this.processingRowIds.has(row.atividade_id)) {
      return;
    }
    this.processingRowIds.add(row.id);
    if (row.atividade_id) this.processingRowIds.add(row.atividade_id);

    try {
      // Marcar como PROCESSANDO no Supabase enquanto estiver na fila de envio
      await this.client
        .from('atividades_umovme')
        .update({ status: 'PROCESSANDO', updated_at: new Date().toISOString() })
        .eq('id', row.id);

      const targetGroups = Array.isArray(row.grupos_destino) ? row.grupos_destino : [];

      if (targetGroups.length === 0) {
        await this.client
          .from('atividades_umovme')
          .update({ status: 'SEM_GRUPO', erro: 'Nenhum grupo mapeado para este Cliente/Rede', updated_at: new Date().toISOString() })
          .eq('id', row.id);
        this.processingRowIds.delete(row.id);
        if (row.atividade_id) this.processingRowIds.delete(row.atividade_id);
        return;
      }

      // 1. Extrair os dados da atividade usando o UmovmeParser completo
      const rawRoot = row.raw_payload || {};
      const activity = UmovmeParser.extractActivityData(rawRoot, {
        urlClient: row.cliente,
        urlNetwork: row.rede
      });

      // 2. Extrair Loja / PDV real do historyId caso venha genérico
      let finalPdvName = (activity.pdvName && activity.pdvName !== 'Loja em Campo') ? activity.pdvName : (row.pdv_nome || '').trim();
      const historyStr = String(rawRoot.historyId || rawRoot.data?.historyId || '');

      if (!finalPdvName || finalPdvName === 'Loja em Campo' || finalPdvName === 'PDV Geral') {
        const storeMatch = historyStr.match(/Loja:\s*([^;]+)/i);
        if (storeMatch && storeMatch[1]) {
          finalPdvName = storeMatch[1].trim();
        } else {
          const razaoMatch = historyStr.match(/Raz[ãa]o\s*Social:\s*([^;]+)/i);
          if (razaoMatch && razaoMatch[1]) finalPdvName = razaoMatch[1].trim();
        }
      }
      if (!finalPdvName) finalPdvName = row.rede ? `Rede ${row.rede}` : 'Loja em Campo';
      activity.pdvName = finalPdvName;

      // 3. Limpar nome do cliente se veio em formato de slug
      let finalClientName = (row.cliente || activity.clientName || '').trim();
      const mappings = Storage.getMappings();
      const matchedRule = (mappings.rules || []).find(r => r.routeSlug === finalClientName || r.client?.toLowerCase() === finalClientName.toLowerCase());
      if (matchedRule && matchedRule.client) {
        finalClientName = matchedRule.client;
      }
      activity.clientName = finalClientName;

      // 4. Garantir campos do banco
      if (row.atividade_id) activity.activityId = row.atividade_id;
      if (row.promotor_nome && (!activity.promoterName || activity.promoterName === 'Promotor de Campo')) {
        activity.promoterName = row.promotor_nome;
      }
      if (row.data_execucao && !activity.date) {
        activity.date = row.data_execucao;
      }

      // 5. Garantir Foto do Mix no texto
      if (!activity.fotoDoMix) {
        const searchMix = JSON.stringify(rawRoot) + ' ' + (row.observacoes || '');
        const mixMatch = searchMix.match(/Foto\s+do\s+Mix:\s*(https?:\/\/[^\s;"'<>]+)/i);
        if (mixMatch && mixMatch[1]) {
          activity.fotoDoMix = mixMatch[1].trim();
        }
      }

      // 6. Excluir a Foto do Mix da fila de fotos para não duplicar como arquivo de imagem
      if (activity.fotoDoMix && Array.isArray(activity.photoUrls)) {
        activity.photoUrls = activity.photoUrls.filter(p => {
          const u = typeof p === 'object' ? p.url : p;
          return u !== activity.fotoDoMix;
        });
      }

      // 7. Descartar placeholders nomedia.png / logo
      if (Array.isArray(activity.photoUrls)) {
        activity.photoUrls = activity.photoUrls.filter(p => {
          const u = typeof p === 'object' ? p.url : p;
          return !u.toLowerCase().includes('nomedia') && !u.toLowerCase().includes('/logo/');
        });
      }

      console.log(`[Supabase Worker] 🚀 Enfileirando atividade #${activity.activityId} (${activity.clientName} | Loja: ${activity.pdvName} | ${activity.photoUrls.length} fotos) para o WhatsApp...`);

      // Enfileirar na fila anti-ban do WhatsApp e só marcar como ENVIADO quando o disparo terminar de fato!
      dispatchQueue.enqueueActivity(activity, targetGroups, {
        onComplete: async () => {
          try {
            await this.client
              .from('atividades_umovme')
              .update({ status: 'ENVIADO', erro: null, updated_at: new Date().toISOString() })
              .eq('id', row.id);
            console.log(`[Supabase Worker] ✅ Atividade #${row.atividade_id} finalizada e marcada como ENVIADO no Supabase.`);
          } finally {
            this.processingRowIds.delete(row.id);
            if (row.atividade_id) this.processingRowIds.delete(row.atividade_id);
          }
        },
        onFail: async (err) => {
          try {
            await this.client
              .from('atividades_umovme')
              .update({ status: 'ERRO', erro: err?.message || 'Falha no envio WhatsApp', updated_at: new Date().toISOString() })
              .eq('id', row.id);
          } finally {
            this.processingRowIds.delete(row.id);
            if (row.atividade_id) this.processingRowIds.delete(row.atividade_id);
          }
        }
      });

    } catch (err) {
      this.processingRowIds.delete(row.id);
      if (row.atividade_id) this.processingRowIds.delete(row.atividade_id);
      console.error(`[Supabase Worker] Erro ao despachar linha #${row.id}:`, err.message);
      await this.client
        .from('atividades_umovme')
        .update({ status: 'ERRO', erro: err.message, updated_at: new Date().toISOString() })
        .eq('id', row.id);
    }
  }

  /**
   * Busca histórico completo dos últimos 7 dias direto do Supabase (persistente 24/7)
   */
  async getHistoryLast7Days() {
    if (!this.enabled || !this.client) {
      this.init();
    }
    if (!this.enabled || !this.client) {
      return Storage.getHistory(500);
    }

    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await this.client
        .from('atividades_umovme')
        .select('id, atividade_id, cliente, rede, pdv_nome, promotor_nome, tipo_atividade, observacoes, data_execucao, fotos, grupos_destino, status, erro, created_at, updated_at')
        .neq('status', 'CANCELADO')
        .gte('created_at', sevenDaysAgo)
        .order('created_at', { ascending: false })
        .limit(1000);

      if (error || !data) {
        console.error('[Supabase Worker] Erro ao buscar histórico de 7 dias:', error?.message);
        return Storage.getHistory(500);
      }

      const activeQueueMap = dispatchQueue.getActiveActivityMap();
      const seenActivityIds = new Set();
      const normalized = [];

      for (const row of data) {
        const actId = row.atividade_id || row.id;
        // Evitar exibir linhas duplicadas da mesma atividade_id
        if (seenActivityIds.has(actId)) continue;
        seenActivityIds.add(actId);

        // Extrair e normalizar fotos válidas para galeria/miniaturas
        const rawPhotos = Array.isArray(row.fotos) ? row.fotos : [];
        const validPhotos = [];
        for (const p of rawPhotos) {
          const rawUrl = typeof p === 'object' ? (p.url || '') : String(p || '');
          const rawLabel = typeof p === 'object' ? (p.label || '') : '';
          if (!rawUrl || rawUrl.toLowerCase().includes('nomedia') || rawUrl.toLowerCase().includes('/logo/')) {
            continue;
          }
          const matches = rawUrl.match(/https?:\/\/(?:(?!https?:\/\/)[^\s;"'<>])+/gi);
          if (matches && matches.length > 0) {
            matches.forEach((u, idx) => {
              if (!u.toLowerCase().includes('nomedia') && !u.toLowerCase().includes('/logo/')) {
                validPhotos.push({
                  url: u,
                  label: idx === 0 ? rawLabel : ''
                });
              }
            });
          } else if (rawUrl.startsWith('http')) {
            validPhotos.push({ url: rawUrl, label: rawLabel });
          }
        }

        // Detectar se houve Ruptura Total reportada nas observações/tipo
        const obsText = String(row.observacoes || '');
        let hasRuptura = false;
        let rupturaText = '';
        const rupMatch = obsText.match(/Ruptura(?:\s+Total)?\s*:\s*([^;\n|]+)/i);
        if (rupMatch && rupMatch[1]) {
          const val = rupMatch[1].trim();
          const lowerVal = val.toLowerCase();
          if (val && !['não', 'nao', 'nenhuma', 'sem ruptura', '0', 'false', '-'].includes(lowerVal)) {
            hasRuptura = true;
            rupturaText = val;
          }
        } else if (/ruptura\s+total\s*:\s*sim/i.test(obsText)) {
          hasRuptura = true;
          rupturaText = 'Sim';
        }

        // Determinar status real sincronizado com a fila em memória
        let finalStatus = 'QUEUED';
        if (activeQueueMap[actId] === 'PROCESSING') {
          finalStatus = 'PROCESSING';
        } else if (activeQueueMap[actId] === 'QUEUED') {
          finalStatus = 'QUEUED';
        } else if (row.status === 'ENVIADO') {
          finalStatus = 'COMPLETED';
        } else if (row.status === 'PENDENTE' || row.status === 'PROCESSANDO') {
          finalStatus = 'QUEUED';
        } else if (row.status === 'ERRO') {
          finalStatus = 'FAILED';
        } else if (row.status === 'SEM_GRUPO') {
          finalStatus = 'IGNORED_NO_GROUP';
        }

        const dateParts = formatBrazilDateParts(row.created_at, row.data_execucao);
        const groups = Array.isArray(row.grupos_destino)
          ? row.grupos_destino.map(g => (typeof g === 'object' ? (g.name || g.id) : String(g)))
          : [];

        normalized.push({
          id: row.id,
          activityId: actId,
          clientName: (row.cliente || '').trim(),
          networkName: (row.rede || '').trim(),
          pdvName: (row.pdv_nome || 'Loja em Campo').trim(),
          promoterName: (row.promotor_nome || 'Promotor de Campo').trim(),
          activityName: (row.tipo_atividade || 'Execução e Reposição em Loja').trim(),
          observacoes: obsText,
          hasRuptura,
          rupturaText,
          date: dateParts.display,
          dateKey: dateParts.dateKey,
          dateLabel: dateParts.dateLabel,
          timestamp: row.created_at,
          updatedAt: row.updated_at,
          photoCount: validPhotos.length,
          photos: validPhotos.slice(0, 20),
          targetGroups: groups.length > 0 ? groups : ['Sem grupo mapeado'],
          status: finalStatus,
          error: row.erro || null
        });
      }

      return normalized;
    } catch (err) {
      console.error('[Supabase Worker] Exceção ao carregar histórico 7 dias:', err.message);
      return Storage.getHistory(500);
    }
  }

  /**
   * Reenvia uma atividade específica que deu falha (ERRO / SEM_GRUPO / PENDENTE travado)
   */
  async retryActivity(idOrActivityId) {
    if (!this.enabled || !this.client) {
      this.init();
    }
    if (!this.client) {
      throw new Error('Supabase não está conectado no momento.');
    }

    const cleanId = String(idOrActivityId || '').trim();
    if (!cleanId) {
      throw new Error('ID da atividade inválido.');
    }

    // Buscar pelo id da linha ou pelo atividade_id
    let row = null;
    const { data: byId } = await this.client
      .from('atividades_umovme')
      .select('*')
      .eq('id', cleanId)
      .maybeSingle();

    if (byId) {
      row = byId;
    } else {
      const { data: byActId } = await this.client
        .from('atividades_umovme')
        .select('*')
        .eq('atividade_id', cleanId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (byActId && byActId.length > 0) {
        row = byActId[0];
      }
    }

    if (!row) {
      throw new Error(`Atividade #${cleanId} não encontrada no banco de dados.`);
    }

    // Se estava sem grupo mapeado antes, tentar resolver os grupos novamente pelas regras atuais
    let targetGroups = Array.isArray(row.grupos_destino) ? row.grupos_destino : [];
    if (targetGroups.length === 0) {
      const rawRoot = row.raw_payload || {};
      const activity = UmovmeParser.extractActivityData(rawRoot, {
        urlClient: row.cliente,
        urlNetwork: row.rede
      });
      const resolved = MessageRouter.resolveTargetGroups(activity, {
        urlClient: row.cliente,
        urlNetwork: row.rede
      });
      if (resolved && resolved.length > 0) {
        targetGroups = resolved;
        row.grupos_destino = resolved;
      }
    }

    if (targetGroups.length === 0) {
      throw new Error(`Ainda não há grupo mapeado para o cliente "${row.cliente || 'N/A'}". Cadastre a regra na aba Clientes & Redes antes de reenviar.`);
    }

    // Limpar trava em memória e atualizar para PENDENTE no Supabase
    this.processingRowIds.delete(row.id);
    if (row.atividade_id) this.processingRowIds.delete(row.atividade_id);

    await this.client
      .from('atividades_umovme')
      .update({
        status: 'PENDENTE',
        erro: null,
        grupos_destino: targetGroups,
        updated_at: new Date().toISOString()
      })
      .eq('id', row.id);

    row.status = 'PENDENTE';
    row.erro = null;

    // Disparar imediatamente se o WhatsApp estiver conectado
    if (whatsappManager.sock && whatsappManager.status === 'CONNECTED') {
      this.handleActivityRow(row);
    }

    return {
      success: true,
      activityId: row.atividade_id || row.id,
      pdvName: row.pdv_nome || 'Loja em Campo'
    };
  }

  /**
   * Reenvia em lote todas as atividades com status ERRO ou SEM_GRUPO dos últimos 7 dias
   */
  async retryAllFailed() {
    if (!this.enabled || !this.client) {
      this.init();
    }
    if (!this.client) {
      throw new Error('Supabase não conectado.');
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.client
      .from('atividades_umovme')
      .select('*')
      .in('status', ['ERRO', 'SEM_GRUPO'])
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      throw new Error(error.message);
    }

    if (!data || data.length === 0) {
      return { count: 0, message: 'Nenhuma atividade com falha encontrada nos últimos 7 dias.' };
    }

    let retriedCount = 0;
    for (const row of data) {
      try {
        await this.retryActivity(row.id);
        retriedCount++;
      } catch (_) {}
    }

    return {
      count: retriedCount,
      message: `${retriedCount} atividade(s) recolocada(s) na fila de envio com sucesso!`
    };
  }
}

const instance = new SupabaseWorker();
module.exports = instance;
