const axios = require('axios');
const Storage = require('./storage');

class UmovmeParser {
  /**
   * Normaliza os dados brutos de webhook da uMov.me em uma estrutura padrão
   * @param {Object} rawPayload
   * @param {Object} context Contexto de URL ou query (urlClient, urlNetwork, etc.)
   * @returns {Object} Dados normalizados
   */
  static extractActivityData(rawPayload, context = {}) {
    if (!rawPayload || typeof rawPayload !== 'object') {
      throw new Error('Payload inválido recebido.');
    }

    const root = rawPayload.activity || rawPayload.data || rawPayload.evento || rawPayload;

    // 1. Identificador da Atividade
    let activityId = 'UMOV-' + Date.now();
    if (rawPayload.correlationid) {
      activityId = String(rawPayload.correlationid);
    } else if (root.id && !String(root.id).startsWith('http')) {
      activityId = String(root.id);
    } else if (root.codigoAtividade) {
      activityId = String(root.codigoAtividade);
    } else if (root.activityId && !String(root.activityId).startsWith('http')) {
      activityId = String(root.activityId);
    }

    // 2. Extrair fotos categorizadas (Antes, Depois, Ponto Extra, Mix, etc.)
    const photoItems = this.collectPhotoReferences(root, rawPayload);

    // Se o activityId ainda for genérico, pegar o ID numérico da primeira foto da uMov.me
    if (activityId.startsWith('UMOV-') && photoItems.length > 0) {
      const firstUrl = typeof photoItems[0] === 'object' ? photoItems[0].url : photoItems[0];
      const matchId = firstUrl.match(/id=(\d+)/i);
      if (matchId && matchId[1]) {
        activityId = `UMOV-${matchId[1]}`;
      }
    }

    // 3. Dados do Promotor / Agente
    const agentObj = root.agent || root.usuario || root.promotor || root.user || {};
    let promoterName = agentObj.name || agentObj.nome || agentObj.nomeCompleto || root.agentName || root.promoterName || root.promotor;
    
    // Suporte ao formato uMov.me onde taskId carrega "Nome PromotorFABIANO PEREIRA"
    if (!promoterName && root.taskId && typeof root.taskId === 'string' && !root.taskId.startsWith('http')) {
      promoterName = root.taskId;
    }
    if (promoterName) {
      promoterName = promoterName.replace(/^(Nome\s+Promotor:?|Promotor:?)/i, '').trim();
    }
    promoterName = promoterName || 'Promotor de Campo';

    // 4. Data, Hora e Loja
    let dateStr = root.endDate || root.dataFim || root.executionDate || root.date;
    let extractedStore = '';
    let extractedNetwork = '';

    // Suporte ao formato uMov.me: "Data:2026-10-29 16:50:14;Loja: OBJETIVA MARKETING;Razão Social: ; Rede:229436480"
    if (root.historyId && typeof root.historyId === 'string') {
      const dateMatch = root.historyId.match(/Data:\s*([^;]+)/i);
      if (dateMatch) dateStr = dateMatch[1].trim();

      const storeMatch = root.historyId.match(/Loja:\s*([^;]+)/i);
      if (storeMatch) extractedStore = storeMatch[1].trim();

      const networkMatch = root.historyId.match(/Rede:\s*([^;]+)/i);
      if (networkMatch) extractedNetwork = networkMatch[1].trim();

      if (!dateStr) {
        const parts = root.historyId.split(';');
        if (parts[0] && parts[0].includes('-')) dateStr = parts[0].trim();
      }
    }
    if (!dateStr) dateStr = new Date().toISOString();

    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        dateStr = d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      }
    } catch {
      // mantém como string
    }

    // 5. Observações / Checklist / Respostas
    let notes = root.notes || root.observacoes || root.comment || '';
    let ruptura = '';
    let observacao = '';
    let fotoDoMix = '';
    const outrosChecklist = [];

    // Suporte ao formato uMov.me em clientId: "Ruptura Total:NÃO;Qual a observação?Observei; Foto do Mix:https://..."
    if (root.clientId && typeof root.clientId === 'string') {
      const parts = root.clientId.split(';').map(p => p.trim()).filter(Boolean);
      parts.forEach(part => {
        if (/foto\s+do\s+mix/i.test(part)) {
          const colonIdx = part.indexOf(':');
          if (colonIdx !== -1) fotoDoMix = part.substring(colonIdx + 1).trim();
        } else if (/ruptura/i.test(part)) {
          const sepIdx = part.indexOf(':') !== -1 ? part.indexOf(':') : part.indexOf('?');
          ruptura = sepIdx !== -1 ? part.substring(sepIdx + 1).trim() : part;
        } else if (/observa/i.test(part)) {
          const sepIdx = part.indexOf(':') !== -1 ? part.indexOf(':') : part.indexOf('?');
          observacao = sepIdx !== -1 ? part.substring(sepIdx + 1).trim() : part;
        } else if (!part.startsWith('http')) {
          outrosChecklist.push(part);
        }
      });
    }

    if (Array.isArray(root.answers)) {
      root.answers.forEach(a => {
        const q = (a.question || '').toLowerCase();
        const ans = String(a.answer || '').trim();
        if (q.includes('ruptura')) ruptura = ruptura || ans;
        else if (q.includes('observa')) observacao = observacao || ans;
        else if (q.includes('mix') && ans.startsWith('http')) fotoDoMix = fotoDoMix || ans;
        else if (ans && !ans.startsWith('http')) outrosChecklist.push(`${a.question}: ${ans}`);
      });
    }

    if (!notes) {
      const combined = [
        ruptura ? `Ruptura Total: ${ruptura}` : null,
        observacao ? `Observação: ${observacao}` : null,
        ...outrosChecklist
      ].filter(Boolean);
      notes = combined.join(' | ') || 'Sem observações adicionais';
    }

    // 6. Dados de Cliente e Rede
    const localObj = root.local || root.client || root.pdv || root.store || root.cliente || {};
    
    let pdvName = (
      extractedStore ||
      localObj.fantasyName ||
      localObj.nomeFantasia ||
      localObj.name ||
      localObj.nome ||
      root.pdvName ||
      root.nomeLocal ||
      ''
    ).trim();

    let pdvCode = String(
      localObj.externalCode ||
      localObj.codigo ||
      localObj.code ||
      localObj.id ||
      root.pdvCode ||
      'S/C'
    ).trim();

    let networkName = (
      context.urlNetwork ||
      extractedNetwork ||
      localObj.network ||
      localObj.rede ||
      localObj.chain ||
      root.network ||
      root.rede ||
      ''
    ).trim();

    let clientName = (
      context.urlClient ||
      localObj.clientName ||
      root.clientName ||
      root.marca ||
      root.brand ||
      root.cliente ||
      ''
    ).trim();

    // Mapeamento e inferência de Rede para regras de roteamento
    const searchableContext = `${pdvName} ${root.historyId || ''} ${networkName}`.toLowerCase();
    if (!networkName || networkName === '229436480' || /^\d+$/.test(networkName)) {
      if (searchableContext.includes('objetiva') || searchableContext.includes('229436480')) networkName = 'Objetiva';
      else if (searchableContext.includes('mundial')) networkName = 'Mundial';
      else if (searchableContext.includes('prezunic')) networkName = 'Prezunic';
      else if (searchableContext.includes('guanabara')) networkName = 'Guanabara';
      else if (searchableContext.includes('assai') || searchableContext.includes('assaí')) networkName = 'Assaí';
      else if (searchableContext.includes('atacadao') || searchableContext.includes('atacadão')) networkName = 'Atacadão';
    }

    // Cliente padrão se não especificado na URL
    if (!clientName) {
      clientName = context.urlClient || 'Fresk';
    }

    if (!pdvName) {
      pdvName = 'Loja em Campo';
    }

    // 7. Tipo de Atividade
    const typeObj = root.activityType || root.tipoAtividade || root.task || {};
    const activityName = (
      typeObj.name ||
      typeObj.description ||
      root.activityName ||
      root.tarefa ||
      'Execução e Reposição em Loja'
    ).trim();

    return {
      activityId,
      promoterName,
      pdvName,
      pdvCode,
      clientName,
      networkName,
      urlClient: context.urlClient || null,
      urlNetwork: context.urlNetwork || null,
      activityName,
      date: dateStr,
      notes: notes || 'Sem observações adicionais',
      ruptura,
      observacao,
      fotoDoMix,
      outrosChecklist,
      photoUrls: photoItems,
      raw: rawPayload
    };
  }

  /**
   * Varre o payload em busca de fotos e detecta automaticamente se são ANTES, DEPOIS, PONTO EXTRA ou MIX.
   * @returns {Array<{ url: string, label: string, category: string }>}
   */
  static collectPhotoReferences(root, rawPayload) {
    const photoMap = new Map();
    const allTexts = [];

    // Se activityId contiver as fotos da atividade (Antes, Depois, Ponto Extra)
    if (typeof root.activityId === 'string' && root.activityId.includes('http')) {
      allTexts.push(root.activityId);
    } else {
      [root, rawPayload].forEach(obj => {
        if (!obj || typeof obj !== 'object') return;
        Object.entries(obj).forEach(([key, val]) => {
          // Excluir clientId aqui se for apenas Foto do Mix para não misturar com as fotos de execução
          if (key === 'clientId' && val.toLowerCase().includes('foto do mix') && !val.toLowerCase().includes('antes')) {
            return;
          }
          if (typeof val === 'string' && val.includes('http')) {
            allTexts.push(val);
          }
        });
      });
    }

    // Procurar por seções categorizadas: Antes, Depois, Ponto Extra, Mix, Backlight
    const tagRegex = /(?:Fotos?\s+do\s+|Fotos?\s+)?(antes|depois|ponto\s+extra|extra|mix|backlight)/gi;

    for (const text of allTexts) {
      const matches = [];
      let m;
      while ((m = tagRegex.exec(text)) !== null) {
        matches.push({ tag: m[1], raw: m[0], index: m.index });
      }

      if (matches.length > 0) {
        for (let i = 0; i < matches.length; i++) {
          const current = matches[i];
          const nextIndex = i + 1 < matches.length ? matches[i + 1].index : text.length;
          const segment = text.substring(current.index, nextIndex);

          const urlMatches = segment.match(/https?:\/\/(?:(?!https?:\/\/)[^\s;"'<>])+/gi) || [];
          const urls = urlMatches
            .map(u => u.trim())
            .filter(u => u.startsWith('http') && !u.toLowerCase().includes('nomedia') && !u.toLowerCase().includes('/logo/') && (u.includes('umov.me') || u.match(/\.(jpe?g|png|webp|gif)/i)));

          let categoryLabel = 'FOTO DO ANTES';
          const lowerTag = (current.tag || '').toLowerCase();
          if (lowerTag.includes('depois')) categoryLabel = 'FOTO DO DEPOIS';
          else if (lowerTag.includes('extra')) categoryLabel = 'FOTO DO PONTO EXTRA';
          else if (lowerTag.includes('backlight')) categoryLabel = 'FOTO DO BACKLIGHT';
          else if (lowerTag.includes('mix')) categoryLabel = 'FOTO DO MIX';

          urls.forEach(url => {
            if (!photoMap.has(url)) {
              photoMap.set(url, {
                url,
                label: categoryLabel,
                category: current.tag
              });
            }
          });
        }
      } else {
        const urlMatches = text.match(/https?:\/\/(?:(?!https?:\/\/)[^\s;"'<>])+/gi) || [];
        const urls = urlMatches
          .map(u => u.trim())
          .filter(u => u.startsWith('http') && !u.toLowerCase().includes('nomedia') && !u.toLowerCase().includes('/logo/') && (u.includes('umov.me') || u.match(/\.(jpe?g|png|webp|gif)/i)));

        urls.forEach(url => {
          if (!photoMap.has(url)) {
            photoMap.set(url, {
              url,
              label: '',
              category: 'geral'
            });
          }
        });
      }
    }

    const items = Array.from(photoMap.values());

    // Se nenhuma tag específica de Antes/Depois foi encontrada pelo texto, aplicar heurística
    const hasSpecificTags = items.some(it => it.label && (it.label.includes('ANTES') || it.label.includes('DEPOIS')));
    if (!hasSpecificTags && items.length > 0) {
      if (items.length === 2) {
        items[0].label = 'FOTO DO ANTES';
        items[1].label = 'FOTO DO DEPOIS';
      } else if (items.length > 2) {
        items[0].label = 'FOTO DO ANTES';
        items[items.length - 1].label = 'FOTO DO DEPOIS';
        for (let i = 1; i < items.length - 1; i++) {
          items[i].label = 'FOTO DO PONTO EXTRA';
        }
      }
    }

    return items;
  }

  /**
   * Baixa a imagem a partir de uma URL remota com timeout seguro
   */
  static async downloadPhoto(url) {
    const settings = Storage.getSettings();
    const cleanUrl = typeof url === 'object' ? url.url : url;

    // Se a URL for explicitamente de placeholder do uMov.me
    if (cleanUrl.toLowerCase().includes('nomedia') || cleanUrl.toLowerCase().includes('/logo/')) {
      throw new Error('Placeholder "MEDIA COMING SOON" descartado por URL.');
    }

    const headers = {
      'User-Agent': 'Trade-Marketing-Integration/1.0'
    };

    if (settings.umovme?.appId && settings.umovme?.appKey && cleanUrl.includes('umov.me')) {
      headers['AppId'] = settings.umovme.appId;
      headers['AppKey'] = settings.umovme.appKey;
    }

    const response = await axios.get(cleanUrl, {
      responseType: 'arraybuffer',
      headers,
      timeout: settings.umovme?.downloadTimeoutMs || 30000
    });

    const buf = Buffer.from(response.data);

    // Verificação de segurança: hash do placeholder "MEDIA COMING SOON"
    const crypto = require('crypto');
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    if (md5 === '283c5b9f4af1f9898f97dad66ccb6e52' || buf.length === 12413) {
      throw new Error('Placeholder "MEDIA COMING SOON" descartado por assinatura de imagem.');
    }

    return buf;
  }
}

module.exports = UmovmeParser;
