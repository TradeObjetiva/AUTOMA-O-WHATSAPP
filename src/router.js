const Storage = require('./storage');

function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

class MessageRouter {
  /**
   * Avalia a atividade contra as regras de mapeamento e retorna os grupos de WhatsApp destinatários.
   * Suporta separação por Cliente + Rede com URLs dedicadas e regras compostas.
   * 
   * @param {Object} activity Objeto normalizado da atividade
   * @param {Object} context Contexto adicional (ex: { urlClient, urlNetwork })
   * @returns {Array<{ id: string, name: string, matchedRule?: string }>}
   */
  static resolveTargetGroups(activity, context = {}) {
    const mappings = Storage.getMappings();
    const settings = Storage.getSettings();
    const matchedGroups = new Map();

    const rules = mappings.rules || [];

    // Contexto de Cliente e Rede (vindos da URL, query params ou payload)
    const clientCandidates = [
      context.urlClient,
      activity.urlClient,
      activity.clientName,
      activity.marca,
      activity.brand
    ].filter(Boolean).map(s => s.trim().toLowerCase());

    const networkCandidates = [
      context.urlNetwork,
      activity.urlNetwork,
      activity.networkName,
      activity.rede,
      activity.pdvName
    ].filter(Boolean).map(s => s.trim().toLowerCase());

    const clientSlugCandidates = clientCandidates.map(slugify);
    const networkSlugCandidates = networkCandidates.map(slugify);

    // =========================================================================
    // NÍVEL 1: Regras Compostas Específicas (CLIENTE + REDE)
    // Ex: Cliente = "Arroz Fantástico" E Rede = "Mundial"
    // =========================================================================
    for (const rule of rules) {
      if (!rule.active || !rule.targetGroupId) continue;

      // Regra de matriz (client + network)
      if (rule.client && rule.network) {
        const ruleClient = rule.client.trim().toLowerCase();
        const ruleClientSlug = slugify(rule.client);
        const ruleNetwork = rule.network.trim().toLowerCase();
        const ruleNetworkSlug = slugify(rule.network);

        const clientMatches = clientCandidates.some(c => c.includes(ruleClient) || ruleClient.includes(c)) ||
                              clientSlugCandidates.some(s => s === ruleClientSlug || s.includes(ruleClientSlug));

        const networkMatches = networkCandidates.some(n => n.includes(ruleNetwork) || ruleNetwork.includes(n)) ||
                               networkSlugCandidates.some(s => s === ruleNetworkSlug || s.includes(ruleNetworkSlug));

        if (clientMatches && networkMatches) {
          matchedGroups.set(rule.targetGroupId, {
            id: rule.targetGroupId,
            name: rule.targetGroupName || 'Grupo Alvo',
            matchedRule: rule.name || `Matriz: ${rule.client} + ${rule.network}`
          });
        }
      }
    }

    // Se encontrou grupos na combinação exata de Cliente + Rede, retorna imediatamente
    if (matchedGroups.size > 0) {
      return Array.from(matchedGroups.values());
    }

    // =========================================================================
    // NÍVEL 2: Regras de Rota / Slug Direto (URL Dedicada)
    // Ex: /api/webhook/umovme/arroz-fantastico/mundial
    // =========================================================================
    const directSlug = [context.urlClient, context.urlNetwork].filter(Boolean).map(slugify).join('/');
    if (directSlug) {
      for (const rule of rules) {
        if (!rule.active || !rule.targetGroupId) continue;
        if (rule.routeSlug && slugify(rule.routeSlug) === directSlug) {
          matchedGroups.set(rule.targetGroupId, {
            id: rule.targetGroupId,
            name: rule.targetGroupName || 'Grupo Alvo',
            matchedRule: rule.name || `URL Dedicada: ${directSlug}`
          });
        }
      }
    }

    if (matchedGroups.size > 0) {
      return Array.from(matchedGroups.values());
    }

    // =========================================================================
    // NÍVEL 3: Regras Gerais (PDV contém, Marca contém, etc.)
    // =========================================================================
    for (const rule of rules) {
      if (!rule.active || !rule.targetGroupId) continue;
      // Pular se for regra de matriz que já foi verificada
      if (rule.client && rule.network) continue;

      const matchType = rule.matchType;
      const targetVal = (rule.matchValue || '').trim().toLowerCase();
      if (!targetVal) continue;

      let isMatch = false;

      switch (matchType) {
        case 'pdv_contains':
          isMatch = (activity.pdvName || '').toLowerCase().includes(targetVal);
          break;
        case 'network_contains':
        case 'rede_contains':
          isMatch = networkCandidates.some(n => n.includes(targetVal));
          break;
        case 'pdv_code_exact':
          isMatch = (activity.pdvCode || '').toLowerCase() === targetVal;
          break;
        case 'promoter_contains':
          isMatch = (activity.promoterName || '').toLowerCase().includes(targetVal);
          break;
        case 'client_contains':
          isMatch = clientCandidates.some(c => c.includes(targetVal));
          break;
        case 'activity_contains':
          isMatch = (activity.activityName || '').toLowerCase().includes(targetVal);
          break;
        default:
          isMatch = false;
      }

      if (isMatch) {
        matchedGroups.set(rule.targetGroupId, {
          id: rule.targetGroupId,
          name: rule.targetGroupName || 'Grupo Alvo',
          matchedRule: rule.name || rule.id
        });
      }
    }

    // =========================================================================
    // NÍVEL 4: Fallback por Cliente (Grupo Geral do Cliente)
    // =========================================================================
    if (matchedGroups.size === 0) {
      for (const rule of rules) {
        if (!rule.active || !rule.targetGroupId) continue;
        if (rule.client && !rule.network) {
          const ruleClient = rule.client.trim().toLowerCase();
          const clientMatches = clientCandidates.some(c => c.includes(ruleClient) || ruleClient.includes(c));
          if (clientMatches) {
            matchedGroups.set(rule.targetGroupId, {
              id: rule.targetGroupId,
              name: rule.targetGroupName || `Geral - ${rule.client}`,
              matchedRule: `Fallback Cliente: ${rule.client}`
            });
            break;
          }
        }
      }
    }

    // =========================================================================
    // NÍVEL 5: Fallback Global do Sistema
    // =========================================================================
    if (matchedGroups.size === 0 && settings.defaultGroup?.enabled && settings.defaultGroup?.groupId) {
      matchedGroups.set(settings.defaultGroup.groupId, {
        id: settings.defaultGroup.groupId,
        name: settings.defaultGroup.groupName || 'Grupo Geral Padrão',
        matchedRule: 'Grupo Padrão Global (Fallback)'
      });
    }

    return Array.from(matchedGroups.values());
  }

  /**
   * Formata a 1ª mensagem de texto inicial
   */
  static formatSummaryCard(activity) {
    const photoCount = activity.photoUrls?.length || 0;
    
    // Loja: descrição real da loja vinda do uMov.me, sem prefixo "Rede"
    let loja = (activity.pdvName || 'Loja em Campo').trim();
    loja = loja.replace(/^Rede\s+/i, '');

    const promotor = activity.promoterName || 'Promotor';
    
    // Data no formato DD/MM/AAAA
    let data = '';
    if (activity.date) {
      const matchIso = activity.date.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (matchIso) {
        data = `${matchIso[3]}/${matchIso[2]}/${matchIso[1]}`;
      } else {
        const matchPt = activity.date.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (matchPt) {
          data = `${matchPt[1]}/${matchPt[2]}/${matchPt[3]}`;
        } else {
          data = activity.date.split(',')[0].split(' ')[0];
        }
      }
    }
    if (!data) {
      const now = new Date();
      data = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    }

    const marca = activity.clientName || 'Fresk';

    const lines = [
      `Loja: ${loja}`,
      `Promotor: ${promotor}`,
      `Data: ${data}`,
      `Marca: ${marca}`
    ];

    if (activity.ruptura) {
      lines.push(`Ruptura Total: ${activity.ruptura}`);
    }
    if (activity.observacao) {
      lines.push(`Observação: ${activity.observacao}`);
    }

    if (Array.isArray(activity.outrosChecklist) && activity.outrosChecklist.length > 0) {
      activity.outrosChecklist.forEach(c => lines.push(c));
    }

    // Foto do Mix exibida como link direto no texto inicial
    let mixLink = activity.fotoDoMix || '';
    if (!mixLink && typeof activity.notes === 'string') {
      const match = activity.notes.match(/Foto\s+do\s+Mix:\s*(https?:\/\/[^\s;"'<>]+)/i);
      if (match) mixLink = match[1];
    }
    if (mixLink) {
      lines.push('');
      lines.push(`Foto do Mix: ${mixLink}`);
    }

    if (photoCount > 0) {
      lines.push('');
      lines.push('📸 Fotos de Antes/Depois a seguir 👇');
    }

    return lines.join('\n');
  }

  /**
   * Formata a legenda individual de cada foto na sequência.
   * Somente o texto solicitado: FOTO DO ANTES, FOTO DO DEPOIS, FOTO DO PONTO EXTRA.
   */
  static formatPhotoCaption(activity, photoObjOrUrl, photoIndex, totalPhotos) {
    let tag = '';
    if (typeof photoObjOrUrl === 'object' && photoObjOrUrl.label) {
      tag = photoObjOrUrl.label;
    }

    const lower = (tag || '').toLowerCase();
    if (lower.includes('antes')) return 'FOTO DO ANTES';
    if (lower.includes('extra')) return 'FOTO DO PONTO EXTRA';
    if (lower.includes('depois')) return 'FOTO DO DEPOIS';
    if (lower.includes('mix')) return 'FOTO DO MIX';

    if (photoIndex === 1) return 'FOTO DO ANTES';
    if (photoIndex === totalPhotos) return 'FOTO DO DEPOIS';
    return 'FOTO DO DEPOIS';
  }

  /**
   * Legenda legada (para compatibilidade)
   */
  static formatCaption(activity, photoIndex, totalPhotos) {
    return this.formatPhotoCaption(activity, null, photoIndex, totalPhotos);
  }
}

module.exports = MessageRouter;
