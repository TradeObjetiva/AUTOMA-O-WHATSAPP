require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Storage = require('./storage');
const dispatchQueue = require('./queue');
const whatsappManager = require('./whatsapp');
const UmovmeParser = require('./parser');

// Polyfill de WebSocket para Node < 22 (necessário para Supabase Realtime)
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    globalThis.WebSocket = require('ws');
  } catch (_) {}
}

class SupabaseWorker {
  constructor() {
    this.client = null;
    this.enabled = false;
    this.pollInterval = null;
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

      // 2. Processar atividades pendentes acumuladas
      this.processPendingActivities();

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

  async syncRulesFromSupabase() {
    if (!this.enabled) return;
    try {
      const { data, error } = await this.client
        .from('regras_roteamento')
        .select('*')
        .eq('ativo', true);

      if (error) {
        // Tabela ainda não criada
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
          active: r.ativo
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
      // Buscar atividades com status PENDENTE
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
    } catch (err) {
      // silencia erro de polling
    }
  }

  async handleActivityRow(row) {
    if (!this.enabled || !whatsappManager.sock || whatsappManager.status !== 'CONNECTED') {
      console.warn(`[Supabase Worker] WhatsApp não conectado. Atividade #${row?.atividade_id} permanece na fila.`);
      return;
    }
    try {
      // Marcar como PROCESSANDO no Supabase para evitar envio duplo
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

      // 5. Garantir que se houver Foto do Mix em qualquer campo (clientId, observacoes, raw_payload), ela seja inserida no texto
      if (!activity.fotoDoMix) {
        const searchMix = JSON.stringify(rawRoot) + ' ' + (row.observacoes || '');
        const mixMatch = searchMix.match(/Foto\s+do\s+Mix:\s*(https?:\/\/[^\s;"'<>]+)/i);
        if (mixMatch && mixMatch[1]) {
          activity.fotoDoMix = mixMatch[1].trim();
        }
      }

      // 6. Excluir a Foto do Mix da fila de fotos para não duplicar como arquivo de imagem (ela vai no texto)
      if (activity.fotoDoMix && Array.isArray(activity.photoUrls)) {
        activity.photoUrls = activity.photoUrls.filter(p => {
          const u = typeof p === 'object' ? p.url : p;
          return u !== activity.fotoDoMix;
        });
      }

      // 7. Descartar fotos de placeholder do uMov.me (MEDIA COMING SOON / nomedia.png)
      if (Array.isArray(activity.photoUrls)) {
        activity.photoUrls = activity.photoUrls.filter(p => {
          const u = typeof p === 'object' ? p.url : p;
          return !u.toLowerCase().includes('nomedia') && !u.toLowerCase().includes('/logo/');
        });
      }

      console.log(`[Supabase Worker] 🚀 Despachando atividade #${activity.activityId} (${activity.clientName} | Loja: ${activity.pdvName} | ${activity.photoUrls.length} fotos + Mix no texto: ${Boolean(activity.fotoDoMix)}) para o WhatsApp...`);

      // Enfileirar na fila anti-ban do WhatsApp
      dispatchQueue.enqueueActivity(activity, targetGroups);

      // Atualizar status para ENVIADO
      await this.client
        .from('atividades_umovme')
        .update({ status: 'ENVIADO', updated_at: new Date().toISOString() })
        .eq('id', row.id);

      console.log(`[Supabase Worker] ✅ Atividade #${row.atividade_id} marcada como ENVIADO no Supabase.`);
    } catch (err) {
      console.error(`[Supabase Worker] Erro ao despachar linha #${row.id}:`, err.message);
      await this.client
        .from('atividades_umovme')
        .update({ status: 'ERRO', erro: err.message, updated_at: new Date().toISOString() })
        .eq('id', row.id);
    }
  }
}

const instance = new SupabaseWorker();
module.exports = instance;
