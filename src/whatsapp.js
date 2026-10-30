const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const AUTH_FOLDER = path.join(__dirname, '../auth_info_baileys');

class WhatsAppManager {
  constructor() {
    this.sock = null;
    this.status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, CONNECTED
    this.qrCodeRaw = null;
    this.qrCodeDataUrl = null;
    this.userProfile = null;
    this.groupsCache = [];
    this.lastGroupsFetch = 0;
    this.logger = pino({ level: 'silent' });
    this.isInitializing = false;
    this.reconnectTimeout = null;
  }

  cancelScheduledReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  scheduleReconnect(delayMs = 4000) {
    this.cancelScheduledReconnect();
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.init();
    }, delayMs);
  }

  async cleanupSocket() {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }
  }

  async init() {
    if (this.isInitializing) {
      console.log('[WhatsApp] Inicialização já em andamento, aguardando...');
      return false;
    }

    this.isInitializing = true;
    this.cancelScheduledReconnect();

    // Limpar socket antigo se ainda existir em memória
    await this.cleanupSocket();

    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    try {
      this.status = 'CONNECTING';
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
      
      let version = [2, 3000, 1017531287];
      let isLatest = true;
      try {
        const vInfo = await fetchLatestBaileysVersion();
        version = vInfo.version;
        isLatest = vInfo.isLatest;
      } catch (verErr) {
        console.warn('[WhatsApp] Aviso ao verificar versão Baileys, usando fallback:', verErr.message);
      }

      console.log(`[WhatsApp] Inicializando Baileys v${version.join('.')} (Última: ${isLatest})`);

      this.sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger)
        },
        generateHighQualityLinkPreview: false,
        syncFullHistory: false, // CRÍTICO: Não carregar histórico pesado para evitar timeout e desconexões
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 300,
        browser: ['Trade Marketing Hub', 'Chrome', '122.0.0']
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrCodeRaw = qr;
          this.status = 'QR_READY';
          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr);
          } catch (e) {
            console.error('[WhatsApp] Erro ao gerar QRCode DataURL:', e);
          }
          console.log('\n[WhatsApp] 📲 NOVO QR CODE GERADO: Escaneie pelo WhatsApp do celular:');
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errorMessage = lastDisconnect?.error?.message || '';
          const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
          const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;

          console.log(`[WhatsApp] Conexão encerrada. Código: ${statusCode || 'N/A'}${errorMessage ? ' (' + errorMessage + ')' : ''}`);

          this.status = 'DISCONNECTED';
          this.qrCodeRaw = null;
          this.qrCodeDataUrl = null;
          this.userProfile = null;

          if (isLoggedOut) {
            console.log('[WhatsApp] ⚠️ Sessão desconectada ou inválida. Limpando credenciais antigas para novo QR Code...');
            this.wipeAuthFolder();
            this.scheduleReconnect(1500);
          } else if (isRestartRequired) {
            console.log('[WhatsApp] 🔄 Reinício solicitado pelo WhatsApp (515). Reconectando rapidamente...');
            this.scheduleReconnect(1500);
          } else {
            console.log('[WhatsApp] ⏳ Queda temporária de conexão. Reconectando em 5 segundos...');
            this.scheduleReconnect(5000);
          }
        } else if (connection === 'open') {
          console.log('[WhatsApp] ✅ CONECTADO COM SUCESSO AO WHATSAPP!');
          this.status = 'CONNECTED';
          this.qrCodeRaw = null;
          this.qrCodeDataUrl = null;
          this.userProfile = this.sock.user;
          this.cancelScheduledReconnect();

          // Buscar grupos disponíveis após estabilizar
          setTimeout(() => this.getGroups(true), 2500);
        }
      });

      this.isInitializing = false;
      return true;
    } catch (error) {
      console.error('[WhatsApp] Erro na inicialização:', error);
      this.status = 'DISCONNECTED';
      this.isInitializing = false;
      this.scheduleReconnect(6000);
      return false;
    }
  }

  wipeAuthFolder() {
    try {
      if (fs.existsSync(AUTH_FOLDER)) {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        console.log('[WhatsApp] 🗑️ Pasta auth_info_baileys limpa com sucesso.');
      }
    } catch (e) {
      console.warn('[WhatsApp] Aviso ao remover pasta de credenciais:', e.message);
    }
  }

  async logout() {
    return await this.resetSession();
  }

  /**
   * Reseta a sessão por completo, fecha qualquer conexão aberta,
   * apaga as credenciais salvas do primeiro WhatsApp e gera um QR Code limpo
   * imediatamente para permitir conectar outro WhatsApp sem conflitos.
   */
  async resetSession() {
    console.log('\n[WhatsApp] 🔄 Resetando sessão para conectar outro WhatsApp...');
    this.cancelScheduledReconnect();

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        await this.sock.logout().catch(() => {});
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }

    this.wipeAuthFolder();

    this.status = 'DISCONNECTED';
    this.qrCodeRaw = null;
    this.qrCodeDataUrl = null;
    this.userProfile = null;
    this.groupsCache = [];
    this.isInitializing = false;

    // Iniciar novo ciclo para gerar novo QR Code
    setTimeout(() => {
      this.init();
    }, 1000);

    return true;
  }

  async getGroups(forceRefresh = false) {
    if (this.status !== 'CONNECTED' || !this.sock) {
      return this.groupsCache;
    }

    const now = Date.now();
    // Cache de 30 segundos
    if (!forceRefresh && (now - this.lastGroupsFetch < 30000) && this.groupsCache.length > 0) {
      return this.groupsCache;
    }

    try {
      const groupsMap = await this.sock.groupFetchAllParticipating();
      const list = Object.values(groupsMap).map(g => ({
        id: g.id,
        subject: g.subject || 'Sem Nome',
        participantsCount: g.participants?.length || 0,
        creation: g.creation,
        owner: g.owner
      }));
      // Ordenar por nome
      list.sort((a, b) => a.subject.localeCompare(b.subject));
      this.groupsCache = list;
      this.lastGroupsFetch = now;
      return list;
    } catch (err) {
      console.error('[WhatsApp] Erro ao buscar grupos participantes:', err.message);
      return this.groupsCache;
    }
  }

  async sendTextMessage(targetJid, text) {
    if (this.status !== 'CONNECTED' || !this.sock) {
      throw new Error('WhatsApp não está conectado no momento.');
    }
    const formattedJid = targetJid.includes('@') ? targetJid : `${targetJid}@g.us`;
    return await this.sock.sendMessage(formattedJid, { text });
  }

  async sendImageMessage(targetJid, imageBufferOrUrl, caption = '') {
    if (this.status !== 'CONNECTED' || !this.sock) {
      throw new Error('WhatsApp não está conectado no momento.');
    }

    const formattedJid = targetJid.includes('@') ? targetJid : `${targetJid}@g.us`;
    const payload = {
      image: Buffer.isBuffer(imageBufferOrUrl) ? imageBufferOrUrl : { url: imageBufferOrUrl },
      caption: caption
    };

    return await this.sock.sendMessage(formattedJid, payload);
  }

  getStatus() {
    return {
      status: this.status,
      connected: this.status === 'CONNECTED',
      qrCodeDataUrl: this.qrCodeDataUrl,
      user: this.userProfile ? {
        id: this.userProfile.id,
        name: this.userProfile.name || this.userProfile.notify || 'Instância Ativa'
      } : null
    };
  }
}

const instance = new WhatsAppManager();
module.exports = instance;
