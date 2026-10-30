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
  }

  async init() {
    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    try {
      this.status = 'CONNECTING';
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
      const { version, isLatest } = await fetchLatestBaileysVersion();

      console.log(`[WhatsApp] Inicializando Baileys v${version.join('.')} (Última: ${isLatest})`);

      this.sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger)
        },
        generateHighQualityLinkPreview: true,
        browser: ['Trade Marketing Hub', 'Chrome', '1.0.0']
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
          console.log('\n[WhatsApp] NOVO QR CODE GERADO: Escaneie pelo WhatsApp do aparelho:');
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          
          console.log(`[WhatsApp] Conexão fechada. Motivo/Código: ${statusCode}. Reconectando: ${shouldReconnect}`);
          this.status = 'DISCONNECTED';
          this.qrCodeRaw = null;
          this.qrCodeDataUrl = null;
          this.userProfile = null;

          if (shouldReconnect) {
            setTimeout(() => this.init(), 4000);
          } else {
            console.log('[WhatsApp] Desconectado permanentemente (logout). Limpando credenciais...');
            if (fs.existsSync(AUTH_FOLDER)) {
              fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            }
            setTimeout(() => this.init(), 2000);
          }
        } else if (connection === 'open') {
          console.log('[WhatsApp] ✅ CONECTADO COM SUCESSO AO WHATSAPP!');
          this.status = 'CONNECTED';
          this.qrCodeRaw = null;
          this.qrCodeDataUrl = null;
          this.userProfile = this.sock.user;
          // Buscar grupos disponíveis
          setTimeout(() => this.getGroups(true), 2000);
        }
      });

      return true;
    } catch (error) {
      console.error('[WhatsApp] Erro na inicialização:', error);
      this.status = 'DISCONNECTED';
      setTimeout(() => this.init(), 6000);
      return false;
    }
  }

  async logout() {
    try {
      if (this.sock) {
        await this.sock.logout();
      }
      if (fs.existsSync(AUTH_FOLDER)) {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      }
      this.status = 'DISCONNECTED';
      this.qrCodeRaw = null;
      this.qrCodeDataUrl = null;
      this.userProfile = null;
      this.init();
      return true;
    } catch (e) {
      console.error('[WhatsApp] Erro ao deslogar:', e);
      return false;
    }
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
      console.error('[WhatsApp] Erro ao buscar grupos participantes:', err);
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
