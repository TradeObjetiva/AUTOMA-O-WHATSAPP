const whatsappManager = require('./whatsapp');
const EvolutionApiClient = require('./evolutionClient');
const Storage = require('./storage');
const UmovmeParser = require('./parser');
const MessageRouter = require('./router');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class DispatchQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.currentItem = null;
  }

  /**
   * Retorna mapa de atividades atualmente em processamento ou na fila em memória
   */
  getActiveActivityMap() {
    const map = {};
    for (const q of this.queue) {
      if (q.activity?.activityId) {
        map[q.activity.activityId] = 'QUEUED';
      }
    }
    if (this.currentItem && this.currentItem.activity?.activityId) {
      map[this.currentItem.activity.activityId] = 'PROCESSING';
    }
    return map;
  }

  /**
   * Adiciona uma atividade normalizada à fila de envio (com proteção contra duplicidade)
   */
  enqueueActivity(activity, targetGroups, options = {}) {
    const actId = activity?.activityId;
    if (actId) {
      if (this.currentItem && this.currentItem.activity?.activityId === actId) {
        console.log(`[Fila] ⚠️ Atividade #${actId} já está sendo processada no momento. Ignorando duplicata.`);
        return this.currentItem;
      }
      const existing = this.queue.find(q => q.activity?.activityId === actId);
      if (existing) {
        console.log(`[Fila] ⚠️ Atividade #${actId} já está na fila de espera. Ignorando duplicata.`);
        return existing;
      }
    }

    const queueItem = {
      id: `queue-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      activity,
      targetGroups,
      enqueuedAt: new Date().toISOString(),
      status: 'QUEUED', // QUEUED, PROCESSING, COMPLETED, FAILED
      retries: 0,
      onComplete: typeof options.onComplete === 'function' ? options.onComplete : null,
      onFail: typeof options.onFail === 'function' ? options.onFail : null
    };

    this.queue.push(queueItem);

    // Registra entrada no histórico local
    Storage.addHistoryEntry({
      id: queueItem.id,
      activityId: activity.activityId,
      clientName: activity.clientName || '',
      networkName: activity.networkName || '',
      pdvName: activity.pdvName,
      promoterName: activity.promoterName,
      activityName: activity.activityName,
      date: activity.date,
      photoCount: (activity.photoUrls || []).length,
      targetGroups: targetGroups.map(g => g.name || g.id),
      status: 'QUEUED'
    });

    console.log(`[Fila] Atividade #${activity.activityId} adicionada à fila para ${targetGroups.length} grupo(s). Total na fila: ${this.queue.length}`);

    this.processNext();
    return queueItem;
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const current = this.queue.shift();
    this.currentItem = current;

    try {
      current.status = 'PROCESSING';
      Storage.updateHistoryStatus(current.id, 'PROCESSING');
      console.log(`[Fila] Processando atividade #${current.activity.activityId}...`);

      const settings = Storage.getSettings();
      const minDelay = (settings.queue?.minDelaySeconds || 3) * 1000;
      const maxDelay = (settings.queue?.maxDelaySeconds || 7) * 1000;
      const useEvolution = settings.whatsapp?.engine === 'evolution';

      // Desmembrar URLs coladas se houver e descartar placeholders nomedia
      const ungluedPhotos = [];
      for (const item of (current.activity.photoUrls || [])) {
        const itemUrl = typeof item === 'object' ? (item.url || '') : String(item || '');
        if (itemUrl.toLowerCase().includes('nomedia') || itemUrl.toLowerCase().includes('/logo/')) {
          continue;
        }
        const matches = itemUrl.match(/https?:\/\/(?:(?!https?:\/\/)[^\s;"'<>])+/gi);
        if (matches && matches.length > 1) {
          matches.forEach((u, idx) => {
            if (!u.toLowerCase().includes('nomedia') && !u.toLowerCase().includes('/logo/')) {
              ungluedPhotos.push(typeof item === 'object' ? { ...item, url: u, label: idx === 0 ? item.label : '' } : u);
            }
          });
        } else {
          ungluedPhotos.push(item);
        }
      }

      const photoUrls = ungluedPhotos;
      const totalPhotos = photoUrls.length;

      for (const group of current.targetGroups) {
        console.log(`[Fila] Enviando para grupo "${group.name}" (${group.id})...`);

        // 1ª MENSAGEM: Card de Resumo Informativo da Atividade
        const summaryCard = MessageRouter.formatSummaryCard(current.activity);
        console.log(`[Fila] 📤 Enviando 1ª Mensagem (Card de Resumo) ao grupo "${group.name}"...`);
        if (useEvolution) {
          await EvolutionApiClient.sendTextMessage(group.id, summaryCard);
        } else {
          await whatsappManager.sendTextMessage(group.id, summaryCard);
        }

        // Intervalo anti-ban antes das fotos
        if (totalPhotos > 0) {
          await sleep(getRandomInt(minDelay, maxDelay));

          // 2ª MENSAGEM EM DIANTE: Fotos sequenciais com legendas (ANTES / DEPOIS)
          for (let i = 0; i < totalPhotos; i++) {
            const photoItem = photoUrls[i];
            const photoUrl = typeof photoItem === 'object' ? photoItem.url : photoItem;
            const photoIndex = i + 1;
            const caption = MessageRouter.formatPhotoCaption(current.activity, photoItem, photoIndex, totalPhotos);

            try {
              console.log(`[Fila] Baixando foto ${photoIndex}/${totalPhotos}: ${photoUrl.substring(0, 70)}...`);
              const photoBuffer = await UmovmeParser.downloadPhoto(photoUrl);

              if (useEvolution) {
                await EvolutionApiClient.sendImageMessage(group.id, photoBuffer, caption, `foto_${photoIndex}.jpg`);
              } else {
                await whatsappManager.sendImageMessage(group.id, photoBuffer, caption);
              }

              console.log(`[Fila] ✅ Foto ${photoIndex}/${totalPhotos} enviada ao grupo ${group.name} (${caption.split('\n')[0]})`);
            } catch (errPhoto) {
              console.error(`[Fila] ⚠️ Falha ao baixar/enviar foto ${photoIndex}/${totalPhotos} (${photoUrl}): ${errPhoto.message}. Foto ignorada (não enviada ao WhatsApp).`);
            }

            // Intervalo humano e anti-ban entre fotos consecutivas
            if (i < totalPhotos - 1) {
              const delay = getRandomInt(minDelay, maxDelay);
              console.log(`[Fila] Aguardando ${Math.round(delay/1000)}s antes da próxima foto (Anti-Ban)...`);
              await sleep(delay);
            }
          }
        }

        // Intervalo entre diferentes grupos destinatários
        await sleep(getRandomInt(minDelay, maxDelay));
      }

      current.status = 'COMPLETED';
      Storage.updateHistoryStatus(current.id, 'COMPLETED');
      if (current.onComplete) {
        try { await current.onComplete(); } catch (_) {}
      }
      console.log(`[Fila] ✅ Atividade #${current.activity.activityId} concluída com sucesso!`);

    } catch (err) {
      console.error(`[Fila] ❌ Erro ao processar atividade #${current.activity.activityId}:`, err);
      const maxRetries = Storage.getSettings().queue?.maxRetries || 3;

      if (current.retries < maxRetries) {
        current.retries++;
        console.log(`[Fila] Reenfileirando atividade (Tentativa ${current.retries}/${maxRetries})...`);
        await sleep(5000);
        this.queue.unshift(current);
      } else {
        current.status = 'FAILED';
        Storage.updateHistoryStatus(current.id, 'FAILED', err.message);
        if (current.onFail) {
          try { await current.onFail(err); } catch (_) {}
        }
      }
    } finally {
      this.currentItem = null;
      this.isProcessing = false;
      // Processar próximo se houver
      setTimeout(() => this.processNext(), 1000);
    }
  }

  getQueueStatus() {
    return {
      isProcessing: this.isProcessing,
      pendingCount: this.queue.length,
      currentItem: this.currentItem ? {
        id: this.currentItem.id,
        activityId: this.currentItem.activity.activityId,
        pdv: this.currentItem.activity.pdvName,
        promoter: this.currentItem.activity.promoterName,
        photos: (this.currentItem.activity.photoUrls || []).length,
        status: 'PROCESSING'
      } : null,
      items: this.queue.map(q => ({
        id: q.id,
        activityId: q.activity.activityId,
        pdv: q.activity.pdvName,
        promoter: q.activity.promoterName,
        photos: (q.activity.photoUrls || []).length,
        status: q.status
      }))
    };
  }
}

const queueInstance = new DispatchQueue();
module.exports = queueInstance;
